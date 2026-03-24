import type { CollateralizationEvent, AgentEligibility } from '../../src/types';

export function createMockCollateralizationEvent(
  overrides: Partial<CollateralizationEvent> = {},
  timestampOffset: number = 0
): CollateralizationEvent {
  const now = Math.floor(Date.now() / 1000);
  return {
    id: `0x${Math.random().toString(16).slice(2, 66)}`,
    agent: `0x${Math.random().toString(16).slice(2, 66)}`,
    amount: BigInt(Math.floor(Math.random() * 1000000000000000000)),
    status: 'registered',
    timestamp: now + timestampOffset,
    transactionHash: `0x${Math.random().toString(16).slice(2, 66)}`,
    blockNumber: Math.floor(Math.random() * 100000000),
    pgtcrId: Math.floor(Math.random() * 10),
    ...overrides,
  };
}

export function createMockEligibleAgent(
  overrides: Partial<AgentEligibility> = {}
): AgentEligibility {
  return {
    agent: `0x${Math.random().toString(16).slice(2, 66)}`,
    collateralizationId: `0x${Math.random().toString(16).slice(2, 66)}`,
    collateralizationSince: Math.floor(Date.now() / 1000) - 4 * 24 * 60 * 60,
    pgtcrId: 1,
    amount: BigInt(1000000000000000000),
    chainId: 1, // default test chain ID (e.g., Sepolia would be 11155111)
    ...overrides,
  };
}

export function createInMemorySQLite(): any {
  const db: any = {
    queries: [],
    data: new Map(),
  };

  db.run = jest.fn((sql: string, params: any[]) => {
    db.queries.push({ sql, params });
    // Very simple mock implementation
    if (sql.includes('CREATE TABLE')) {
      return Promise.resolve({ changes: 0 });
    }
    if (sql.includes('INSERT')) {
      const key = `${params[0]}:${params[1]}`;
      db.data.set(key, {
        agent_id: params[0],
        collateralization_id: params[1],
        pgtcr_id: params[2],
        first_seen_at: params[3],
        eligible_at: null,
        feedback_sent_at: null,
        tx_hash: null,
      });
      return Promise.resolve({ changes: 1 });
    }
    if (sql.includes('UPDATE')) {
      const [eligibleAt, agentId, collateralizationId] = params;
      const key = `${agentId}:${collateralizationId}`;
      const existing = db.data.get(key);
      if (existing) {
        db.data.set(key, { ...existing, eligible_at: eligibleAt });
      }
      return Promise.resolve({ changes: 1 });
    }
    if (sql.includes('DELETE')) {
      let deleted = 0;
      for (const [key, row] of db.data) {
        if (row.feedback_sent_at && row.feedback_sent_at < params[0]) {
          db.data.delete(key);
          deleted++;
        }
      }
      return Promise.resolve({ changes: deleted });
    }
    return Promise.resolve({ changes: 0 });
  });

  db.get = jest.fn((sql: string, params: any[]) => {
    db.queries.push({ sql, params });
    if (sql.includes('SELECT') && sql.includes('feedback_sent_at IS NULL')) {
      // Return unsent eligible agents
      const results: any[] = [];
      for (const row of db.data.values()) {
        if (row.eligible_at && !row.feedback_sent_at) {
          results.push({
            agent: row.agent_id,
            collateralizationId: row.collateralization_id,
            pgtcrId: row.pgtcr_id,
            firstSeenAt: row.first_seen_at,
          });
        }
      }
      return Promise.resolve(results);
    }
    return Promise.resolve(null);
  });

  db.all = jest.fn((sql: string, params: any[]) => {
    db.queries.push({ sql, params });
    if (sql.includes('SELECT') && sql.includes('feedback_sent_at IS NULL')) {
      const results: any[] = [];
      for (const row of db.data.values()) {
        if (row.eligible_at && !row.feedback_sent_at) {
          results.push({
            agent: row.agent_id,
            collateralizationId: row.collateralization_id,
            pgtcrId: row.pgtcr_id,
            firstSeenAt: row.first_seen_at,
          });
        }
      }
      return Promise.resolve(results);
    }
    if (sql.includes('SELECT')) {
      return Promise.resolve(Array.from(db.data.values()));
    }
    return Promise.resolve([]);
  });

  db.close = jest.fn(() => Promise.resolve());

  return db;
}
