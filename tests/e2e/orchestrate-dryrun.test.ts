import { sampleCollateralizationEvents } from '../fixtures/sample-events';
import fs from 'fs';
import path from 'path';

// Mock the entire goldsky-client module to avoid real network calls
jest.mock('../../src/goldsky-client', () => ({
  goldskyClient: {
    fetchCurrentActiveCollateralizations: jest.fn(),
  },
}));

// Increase timeout for e2e tests
jest.setTimeout(30000);

// Declare variables that will be assigned after dynamic imports
let store: any;
let orchestrateRun: any;
let metricsService: any;
let goldskyClient: any;
let testDbPath: string;

// Helper to run a raw SQL query on the store's SQLite database
function queryDb(store: any, sql: string, params: any[] = []): Promise<any[]> {
  return new Promise((resolve, reject) => {
    store.db.all(sql, params, (err: any, rows: any[]) => {
      if (err) reject(err);
      else resolve(rows);
    });
  });
}

describe('E2E Orchestrate with Mocks (Dry Run)', () => {
  let originalEnv: typeof process.env;

  beforeAll(async () => {
    // Save original env
    originalEnv = { ...process.env };

    // Use a file-based SQLite database for persistence across potential store reinstantiations
    testDbPath = path.resolve(__dirname, 'test-db.sqlite');
    // Ensure clean start
    if (fs.existsSync(testDbPath)) {
      fs.unlinkSync(testDbPath);
    }

    // Set test environment BEFORE importing modules that read config
    process.env.NODE_ENV = 'test';
    process.env.DATABASE_PATH = testDbPath;
    process.env.DRY_RUN = 'true';
    process.env.CHAIN_ID = '11155111';
    process.env.GOLDSKY_ENDPOINT = 'https://test.example.com/graphql';
    process.env.REPUTATION_REGISTRY_ADDRESS = '0x0000000000000000000000000000000000000000';
    process.env.PRIVATE_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
    process.env.MIN_ACTIVE_DAYS = '7'; // Required for age threshold
    process.env.ONCHAIN_DUPLICATE_PROTECTION = 'false';
    process.env.REVOKE_ON_ABSENCE = 'false';
    // Also set PGTCR_REGISTRY_ADDRESS as it's required
    process.env.PGTCR_REGISTRY_ADDRESS = '0x0000000000000000000000000000000000000000';
    // Disable metrics (ENABLE_METRICS defaults to false)

    // Reset module registry to ensure fresh module loads with new env
    jest.resetModules();

    // Reset config cache before importing modules that read env.
    const { resetConfig } = await import('../../src/config');
    resetConfig();

    // Now import the modules under test
    const storeModule = await import('../../src/store');
    store = storeModule.store;

    const indexModule = await import('../../src/index');
    orchestrateRun = indexModule.orchestrateRun;

    const metricsModule = await import('../../src/metrics');
    metricsService = metricsModule.metricsService;
    // Stub metricsService.init to avoid server startup issues in tests
    metricsService.init = jest.fn().mockResolvedValue(undefined);

    const goldskyModule = await import('../../src/goldsky-client');
    goldskyClient = goldskyModule.goldskyClient;

    // Initialize store (will create in-memory DB)
    await store.init();
  });

  beforeEach(() => {
    // Set mock implementation for Goldsky client before each test (resetMocks clears it)
    goldskyClient.fetchCurrentActiveCollateralizations.mockResolvedValue(sampleCollateralizationEvents);
  });

  afterAll(async () => {
    // Restore env
    process.env = originalEnv;
    // Cleanup
    if (store && typeof store.close === 'function') {
      await store.close();
    }
    if (fs.existsSync(testDbPath)) {
      fs.unlinkSync(testDbPath);
    }
    // Reset config cache
    const { resetConfig } = await import('../../src/config');
    resetConfig();
  });

  afterEach(async () => {
    // Clear mock calls
    if (goldskyClient) {
      goldskyClient.fetchCurrentActiveCollateralizations.mockClear();
    }
    // Shutdown metrics server if it was started (shouldn't be, but just in case)
    try {
      await metricsService.shutdown();
    } catch (e) {
      // ignore
    }
  });

  it('should complete a full cycle with fabricated data', async () => {
    // Run the orchestration
    const stats = await orchestrateRun();

    // Verify stats
    expect(stats.totalEvents).toBe(sampleCollateralizationEvents.length);
    // With real time (now), all four 'registered' events are older than 3 days, so eligible count is 4
    expect(stats.eligibleAgents).toBe(4);
    // Dry-run mode skips DB finalization, so feedbackSent tracks committed sends and remains 0.
    expect(stats.feedbackSent).toBe(0);
    expect(stats.errorsCount).toBe(0);
    expect(stats.runId).toBeDefined();

    // Verify that goldsky fetch was called once
    expect(goldskyClient.fetchCurrentActiveCollateralizations).toHaveBeenCalledTimes(1);

    // After first dry-run, eligible entries are claimed (status = 'pending') so getUnsentEligible returns 0
    const unsent = await store.getUnsentEligible();
    expect(unsent).toHaveLength(0);

    // But feedback_sent_at and tx_hash should NOT be set (dry-run skips DB update)
    const rows = await queryDb(store, `SELECT * FROM processed_entries WHERE eligible_at IS NOT NULL`);
    expect(rows.length).toBe(4);
    for (const row of rows) {
      expect(row.feedback_sent_at).toBeNull();
      expect(row.tx_hash).toBeNull();
    }
  });

  it('should be idempotent on second run', async () => {
    // Second run with same data should find no work to claim (entries are pending from first run)
    const stats2 = await orchestrateRun();

    // feedbackSent should be 0 because dry-run never commits sends
    expect(stats2.feedbackSent).toBe(0);
    // eligibleAgents count reported should still be 4 (total eligible before dedup)
    expect(stats2.eligibleAgents).toBe(4);

    // Unsent eligible should be 0 (entries are pending, not available)
    const unsent = await store.getUnsentEligible();
    expect(unsent).toHaveLength(0);

    // DB should still have all 4 eligible entries with feedback_sent_at NULL and tx_hash NULL
    const rows = await queryDb(store, `SELECT * FROM processed_entries WHERE eligible_at IS NOT NULL`);
    expect(rows.length).toBe(4);
    for (const row of rows) {
      expect(row.feedback_sent_at).toBeNull();
      expect(row.tx_hash).toBeNull();
    }
  });
});
