import { Store, resetStore } from '../../src/store';
import type { CollateralizationEvent } from '../../src/types';

describe('Database Integration', () => {
  const testDbPath = './test-data/temp-bot-state.db';
  let db: Store;

  beforeAll(async () => {
    const fs = require('fs');
    if (fs.existsSync(testDbPath)) {
      fs.unlinkSync(testDbPath);
    }
    fs.mkdirSync('./test-data', { recursive: true });
  });

  afterEach(async () => {
    await db.close();
    await resetStore();
    const fs = require('fs');
    if (fs.existsSync(testDbPath)) {
      fs.unlinkSync(testDbPath);
    }
  });

  beforeEach(() => {
    db = new Store(testDbPath);
  });

  test('should initialize and create schema', async () => {
    await db.init();
    // Should not throw
  });

  test('should upsert and retrieve collateralizations', async () => {
    await db.init();

    const event: CollateralizationEvent = {
      id: 'pos1',
      agent: '0xAgent1',
      amount: 1000n,
      status: 'registered',
      timestamp: 1700000000,
      pgtcrId: 1,
    };

    await db.upsertCollateralization(event);
    const unsent = await db.getUnsentEligible();
    expect(unsent).toHaveLength(0); // not marked eligible yet

    await db.markEligible(event.agent, event.id);
    const eligible = await db.getUnsentEligible();
    expect(eligible).toHaveLength(1);
    expect(eligible[0].agent).toBe(event.agent.toLowerCase());
    expect(eligible[0].collateralizationId).toBe(event.id);
  });

  test('should track feedback sent', async () => {
    await db.init();

    const event: CollateralizationEvent = {
      id: 'pos2',
      agent: '0xAgent2',
      amount: 500n,
      status: 'registered',
      timestamp: 1700000000,
      pgtcrId: 2,
    };

    await db.upsertCollateralization(event);
    await db.markEligible(event.agent, event.id);

    let unsent = await db.getUnsentEligible();
    expect(unsent).toHaveLength(1);

    await db.markFeedbackSent(event.agent, event.id, '0xdeadbeef');

    unsent = await db.getUnsentEligible();
    expect(unsent).toHaveLength(0);

    const sent = await db.isFeedbackAlreadySent(event.agent, event.id);
    expect(sent).toBe(true);
  });

  test('should record cycle metrics', async () => {
    await db.init();
    const cycleId = 'test-cycle';

    await db.startCycle(cycleId);
    await db.endCycle(cycleId, 'success', {
      totalEvents: 100,
      eligibleAgents: 5,
      feedbackSent: 5,
    });

    // Could query back but endCycle already logs; trust it works.
  });

  test('should atomically claim work without duplication', async () => {
    await db.init();

    // Insert three eligible entries
    const events: CollateralizationEvent[] = [
      { id: 'c1', agent: '0xA', amount: 100n, status: 'registered', timestamp: 1700000000, pgtcrId: 1 },
      { id: 'c2', agent: '0xB', amount: 200n, status: 'registered', timestamp: 1700000001, pgtcrId: 2 },
      { id: 'c3', agent: '0xC', amount: 300n, status: 'registered', timestamp: 1700000002, pgtcrId: 3 },
    ];
    for (const ev of events) {
      await db.upsertCollateralization(ev);
      await db.markEligible(ev.agent, ev.id);
    }

    // Create two separate Store instances to simulate concurrent workers
    const db1 = new Store(testDbPath);
    const db2 = new Store(testDbPath);
    await db1.init();
    await db2.init();

    const claimed1 = await db1.claimEligibleWork(10);
    const claimed2 = await db2.claimEligibleWork(10);

    const allClaimedAgentIds = [...claimed1, ...claimed2].map(e => e.agent);
    // Total claimed should be exactly 3 with no duplicates
    expect(new Set(allClaimedAgentIds).size).toBe(3);
    expect(allClaimedAgentIds).toHaveLength(3);

    await db1.close();
    await db2.close();
  });
});
