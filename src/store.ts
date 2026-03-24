import * as sqlite3 from 'sqlite3';
import { promisify } from 'util';
import fs from 'fs/promises';
import path from 'path';
import { getConfig } from './config';
import logger from './logger';
import { withRetry, DEFAULT_RETRY_CONFIG } from './utils/retry';
import type { CollateralizationEvent, AgentEligibility } from './types';

// Allow injection of a custom Database constructor (e.g., for testing)
const DbConstructor: any = (global as any).__SQLITE3_DB_CONSTRUCTOR__ || sqlite3.Database;

export class Store {
  private db: any = null;
  private dbPath?: string;
  private runAsync!: (sql: string, params?: any[]) => Promise<any>;
  private allAsync!: (sql: string, params?: any[]) => Promise<any[]>;
  private getAsync!: (sql: string, params?: any) => Promise<any>;

  constructor(dbPath?: string) {
    this.dbPath = dbPath;
  }

  async init(): Promise<void> {
    if (this.db) {return;}

    try {
      const config = getConfig();
      const effectivePath = this.dbPath ?? config.DATABASE_PATH;
      if (effectivePath !== ':memory:') {
        const dbDir = path.dirname(effectivePath);
        if (dbDir) {
          await fs.mkdir(dbDir, { recursive: true });
        }
      }

      this.db = new DbConstructor(effectivePath, (err: any) => {
        if (err) {
          logger.error('Failed to open SQLite database', { error: err.message });
          throw err;
        }
        logger.info('Connected to SQLite database', { path: effectivePath });
      });

      // Promisify instance methods (raw)
      // For run, we need to capture the Statement (this) to get changes/lastID
      this.runAsync = (sql: string, params?: any[]): Promise<sqlite3.Statement> => {
        return new Promise((resolve, reject) => {
          this.db.run(sql, params || [], function(this: sqlite3.Statement, err: Error | null) {
            if (err) {reject(err);}
            else {resolve(this);}
          });
        });
      };
      this.allAsync = promisify(this.db.all.bind(this.db));
      this.getAsync = promisify(this.db.get.bind(this.db));

      // Set WAL mode and busy timeout for concurrency
      await this.setPragmas();

      // Ensure schema is up-to-date (create tables if missing, run migrations)
      await this.ensureSchema();

      logger.info('Store initialized');
    } catch (error) {
      logger.error('Store initialization failed', error as Error);
      throw error;
    }
  }

  private setPragmas(): Promise<void> {
    return this.run('PRAGMA journal_mode=WAL', [])
      .then(() => this.run('PRAGMA busy_timeout=5000', []))
      .catch((err) => {
        logger.warn('Failed to set some PRAGMA values', { error: (err as Error).message });
      });
  }

  private async ensureSchema(): Promise<void> {
    await this.createTables();
    await this.runMigrations();
    logger.debug('Schema ensured');
  }

  private async createTables(): Promise<void> {
    // processed_entries with status enum and pending_at (deprecated but kept for backwards compat)
    await this.run(`
      CREATE TABLE IF NOT EXISTS processed_entries (
        agent_id TEXT NOT NULL,
        collateralization_id TEXT NOT NULL,
        pgtcr_id INTEGER NOT NULL,
        first_seen_at INTEGER NOT NULL,
        eligible_at INTEGER,
        feedback_sent_at INTEGER,
        feedback_index INTEGER,
        tx_hash TEXT,
        revoked_at INTEGER,
        revoked_tx_hash TEXT,
        status TEXT DEFAULT 'available',
        pending_at INTEGER,
        PRIMARY KEY (agent_id, collateralization_id)
      )
    `);

    // Indexes
    await this.run(`CREATE INDEX IF NOT EXISTS idx_eligible ON processed_entries(eligible_at DESC)`);
    await this.run(`CREATE INDEX IF NOT EXISTS idx_agent ON processed_entries(agent_id)`);
    await this.run(`CREATE INDEX IF NOT EXISTS idx_pending ON processed_entries(pending_at)`);
    await this.run(`CREATE INDEX IF NOT EXISTS idx_sent ON processed_entries(feedback_sent_at)`);
    await this.run(`CREATE INDEX IF NOT EXISTS idx_status ON processed_entries(status)`);
    await this.run(`CREATE INDEX IF NOT EXISTS idx_revoked ON processed_entries(revoked_at)`);
    await this.run(`CREATE INDEX IF NOT EXISTS idx_feedback_index ON processed_entries(feedback_index)`);

    // Feedback idempotency: unique index on (agent_id, collateralization_id) where feedback_sent_at is not null
    // This ensures we can't mark feedback sent twice for the same entry
    await this.run(`
      CREATE UNIQUE INDEX IF NOT EXISTS feedback_index 
      ON processed_entries(agent_id, collateralization_id) 
      WHERE feedback_sent_at IS NOT NULL
    `);

    // Error log table
    await this.run(`
      CREATE TABLE IF NOT EXISTS error_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp INTEGER NOT NULL,
        component TEXT NOT NULL,
        message TEXT NOT NULL,
        details TEXT,
        retry_count INTEGER DEFAULT 0
      )
    `);

    // Cycle metrics table
    await this.run(`
      CREATE TABLE IF NOT EXISTS cycle_metrics (
        cycle_id TEXT PRIMARY KEY,
        start_time INTEGER NOT NULL,
        end_time INTEGER,
        total_events INTEGER DEFAULT 0,
        eligible_agents INTEGER DEFAULT 0,
        feedback_sent INTEGER DEFAULT 0,
        errors INTEGER DEFAULT 0,
        status TEXT DEFAULT 'running'
      )
    `);

    // Schema migrations tracking table
    await this.run(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY
      )
    `);
  }

  private async runMigrations(): Promise<void> {
    let currentVersion = 0;
    try {
      const row = await this.get('SELECT MAX(version) as v FROM schema_migrations');
      if (row && row.v !== null) {
        currentVersion = row.v;
      }
    } catch (error) {
      logger.warn('Failed to query schema_migrations, assuming fresh DB', { error: (error as Error).message });
    }

    if (currentVersion === 0) {
      await this.run('INSERT INTO schema_migrations (version) VALUES (4)');
      logger.info('Applied initial schema version 4');
      return;
    }

    if (currentVersion < 2) {
      // Migration 2: Add pending_at, error_log, cycle_metrics, and indexes
      try {
        await this.run('ALTER TABLE processed_entries ADD COLUMN pending_at INTEGER');
      } catch (error: any) {
        if (!error.message.includes('duplicate column')) {
          throw error;
        }
        logger.debug('pending_at column already exists');
      }
      await this.run('CREATE INDEX IF NOT EXISTS idx_pending ON processed_entries(pending_at)');
      await this.run('CREATE INDEX IF NOT EXISTS idx_sent ON processed_entries(feedback_sent_at)');
      await this.run(`
        CREATE TABLE IF NOT EXISTS error_log (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          timestamp INTEGER NOT NULL,
          component TEXT NOT NULL,
          message TEXT NOT NULL,
          details TEXT,
          retry_count INTEGER DEFAULT 0
        )
      `);
      await this.run(`
        CREATE TABLE IF NOT EXISTS cycle_metrics (
          cycle_id TEXT PRIMARY KEY,
          start_time INTEGER NOT NULL,
          end_time INTEGER,
          total_events INTEGER DEFAULT 0,
          eligible_agents INTEGER DEFAULT 0,
          feedback_sent INTEGER DEFAULT 0,
          errors INTEGER DEFAULT 0,
          status TEXT DEFAULT 'running'
        )
      `);
      await this.run('INSERT INTO schema_migrations (version) VALUES (2)');
      logger.info('Upgraded schema to version 2');
    }

    if (currentVersion < 4) {
      // Migration 4: Add feedback_index, revoked_at, revoked_tx_hash columns and related indexes
      try {
        await this.run(`ALTER TABLE processed_entries ADD COLUMN feedback_index INTEGER`);
      } catch (error: any) {
        if (!error.message.includes('duplicate column')) {
          throw error;
        }
        logger.debug('feedback_index column already exists');
      }
      try {
        await this.run(`ALTER TABLE processed_entries ADD COLUMN revoked_at INTEGER`);
      } catch (error: any) {
        if (!error.message.includes('duplicate column')) {
          throw error;
        }
        logger.debug('revoked_at column already exists');
      }
      try {
        await this.run(`ALTER TABLE processed_entries ADD COLUMN revoked_tx_hash TEXT`);
      } catch (error: any) {
        if (!error.message.includes('duplicate column')) {
          throw error;
        }
        logger.debug('revoked_tx_hash column already exists');
      }

      // Add indexes for revocation tracking
      await this.run(`CREATE INDEX IF NOT EXISTS idx_revoked ON processed_entries(revoked_at)`);
      await this.run(`CREATE INDEX IF NOT EXISTS idx_feedback_index ON processed_entries(feedback_index)`);

      await this.run('INSERT INTO schema_migrations (version) VALUES (4)');
      logger.info('Upgraded schema to version 4 with revocation columns');
    }
  }

  private async run(sql: string, params?: any[]): Promise<any> {
    return withRetry(() => this.runAsync(sql, params), DEFAULT_RETRY_CONFIG, 'DB run');
  }

  public async all(sql: string, params?: any[]): Promise<any[]> {
    return withRetry(() => this.allAsync(sql, params), DEFAULT_RETRY_CONFIG, 'DB all');
  }

  private async get(sql: string, params?: any): Promise<any> {
    return withRetry(() => this.getAsync(sql, params), DEFAULT_RETRY_CONFIG, 'DB get');
  }

  async upsertCollateralization(event: CollateralizationEvent): Promise<void> {
    const sql = `
      INSERT INTO processed_entries (agent_id, collateralization_id, pgtcr_id, first_seen_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(agent_id, collateralization_id) DO NOTHING
    `;
    try {
      await this.run(sql, [
        event.agent.toLowerCase(),
        event.id,
        event.pgtcrId,
        event.timestamp,
      ]);
    } catch (error) {
      logger.error('Failed to upsert collateralization', { eventId: event.id, error });
      throw error;
    }
  }

  async bulkUpsertCollateralizations(events: CollateralizationEvent[]): Promise<void> {
    return withRetry(async () => {
      if (events.length === 0) {return;}
      if (!this.db) {throw new Error('Store not initialized');}

      const stmt = this.db.prepare(`
        INSERT OR IGNORE INTO processed_entries (agent_id, collateralization_id, pgtcr_id, first_seen_at)
        VALUES (?, ?, ?, ?)
      `);

      const transaction = (this.db as any).transaction(() => {
        for (const event of events) {
          stmt.run(
            event.agent.toLowerCase(),
            event.id,
            event.pgtcrId,
            event.timestamp
          );
        }
      });

      await new Promise<void>((resolve, reject) => {
        transaction((err: any) => {
          if (err) {reject(err);}
          else {resolve();}
        });
      });

      logger.debug(`Bulk upserted ${events.length} collateralizations`);
    }, DEFAULT_RETRY_CONFIG, 'bulkUpsertCollateralizations');
  }

  async markEligible(agentId: string, collateralizationId: string): Promise<void> {
    const sql = `
      UPDATE processed_entries
      SET eligible_at = ?
      WHERE agent_id = ? AND collateralization_id = ? AND eligible_at IS NULL
    `;
    const now = Math.floor(Date.now() / 1000);
    try {
      const result = await this.run(sql, [now, agentId.toLowerCase(), collateralizationId]);

      if (result.changes === 0) {
        logger.debug('Eligibility marker already present or row missing', { agentId, collateralizationId });
      }
    } catch (error) {
      logger.error('Failed to mark eligible', { agentId, collateralizationId, error });
      throw error;
    }
  }

  async markFeedbackSent(
    agentId: string,
    collateralizationId: string,
    txHash: string,
    feedbackIndex?: number
  ): Promise<void> {
    const config = getConfig();
    if (config.DRY_RUN) {
      logger.debug('[DRY RUN] Skipping markFeedbackSent DB update', {
        agentId,
        collateralizationId,
        txHash,
        feedbackIndex,
      });
      return;
    }

    const sql = `
      UPDATE processed_entries
      SET feedback_sent_at = ?, tx_hash = ?, feedback_index = ?, status = 'completed'
      WHERE agent_id = ? AND collateralization_id = ?
    `;
    const now = Math.floor(Date.now() / 1000);
    try {
      const result = await this.run(sql, [
        now,
        txHash,
        feedbackIndex ?? null,
        agentId.toLowerCase(),
        collateralizationId,
      ]);

      if (result.changes === 0) {
        logger.warn('No entry found to mark feedback sent', { agentId, collateralizationId });
      }
    } catch (error) {
      logger.error('Failed to mark feedback sent', { agentId, collateralizationId, txHash, error });
      throw error;
    }
  }

  async markFeedbackTracked(
    agentId: string,
    collateralizationId: string,
    feedbackIndex?: number,
    txHash?: string
  ): Promise<void> {
    const sql = `
      UPDATE processed_entries
      SET feedback_sent_at = COALESCE(feedback_sent_at, ?),
          tx_hash = COALESCE(tx_hash, ?),
          feedback_index = COALESCE(feedback_index, ?),
          status = 'completed'
      WHERE agent_id = ? AND collateralization_id = ?
    `;
    const now = Math.floor(Date.now() / 1000);
    try {
      const result = await this.run(sql, [
        now,
        txHash ?? null,
        feedbackIndex ?? null,
        agentId.toLowerCase(),
        collateralizationId,
      ]);

      if (result.changes === 0) {
        logger.warn('No entry found to mark feedback tracked', { agentId, collateralizationId, feedbackIndex });
      }
    } catch (error) {
      logger.error('Failed to mark feedback tracked', { agentId, collateralizationId, feedbackIndex, error });
      throw error;
    }
  }

  async markRevoked(
    collateralizationId: string,
    txHash: string
  ): Promise<void> {
    const sql = `
      UPDATE processed_entries
      SET revoked_at = ?, revoked_tx_hash = ?
      WHERE collateralization_id = ? AND revoked_at IS NULL
    `;
    const now = Math.floor(Date.now() / 1000);
    try {
      const result = await this.run(sql, [now, txHash, collateralizationId]);

      if (result.changes === 0) {
        logger.warn('No entry found to mark revoked', { collateralizationId });
      }
    } catch (error) {
      logger.error('Failed to mark revoked', { collateralizationId, txHash, error });
      throw error;
    }
  }

  async getUnsentEligible(): Promise<AgentEligibility[]> {
    const config = getConfig();
    const sql = `
      SELECT 
        agent_id as agent,
        collateralization_id as collateralizationId,
        pgtcr_id as pgtcrId,
        first_seen_at as firstSeenAt
      FROM processed_entries
      WHERE status = 'available' AND eligible_at IS NOT NULL AND feedback_sent_at IS NULL
      ORDER BY eligible_at ASC
    `;
    try {
      const rows = await this.all(sql);
      return rows.map((row: any) => ({
        agent: row.agent,
        collateralizationId: row.collateralizationId,
        collateralizationSince: row.firstSeenAt,
        pgtcrId: row.pgtcrId,
        amount: 0n,
        chainId: config.CHAIN_ID,
      }));
    } catch (error) {
      logger.error('Failed to fetch unsent eligible', { error });
      return [];
    }
  }

  async claimEligibleWork(limit: number = 10): Promise<AgentEligibility[]> {
    const config = getConfig();
    if (!this.db) {throw new Error('Store not initialized');}
    try {
      await this.run('BEGIN IMMEDIATE TRANSACTION', []);
      // Atomically claim work by updating status from 'available' to 'pending' and setting pending_at,
      // using RETURNING to fetch exactly the claimed rows.
      const now = Math.floor(Date.now() / 1000);
      const returnedRows = await this.allAsync(
        `UPDATE processed_entries
         SET status = 'pending', pending_at = ?
         WHERE rowid IN (
           SELECT rowid FROM processed_entries
           WHERE status = 'available' AND eligible_at IS NOT NULL AND feedback_sent_at IS NULL
           ORDER BY eligible_at ASC, first_seen_at ASC
           LIMIT ?
         )
         RETURNING agent_id, collateralization_id, pgtcr_id, first_seen_at`,
        [now, limit]
      );
      const result: AgentEligibility[] = returnedRows.map((row: any) => ({
        agent: row.agent_id,
        collateralizationId: row.collateralization_id,
        pgtcrId: row.pgtcr_id,
        collateralizationSince: row.first_seen_at,
        amount: 0n,
        chainId: config.CHAIN_ID,
      }));
      await this.run('COMMIT', []);
      return result;
    } catch (err) {
      await this.run('ROLLBACK', []).catch(() => {});
      throw err;
    }
  }

  async resetStaleClaims(olderThanSeconds: number = 3600): Promise<number> {
    const cutoff = Math.floor(Date.now() / 1000) - olderThanSeconds;
    // Reset stale pending claims back to available based on pending_at timestamp
    const result = await this.run(
      `UPDATE processed_entries SET status = 'available', pending_at = NULL WHERE status = 'pending' AND pending_at IS NOT NULL AND pending_at < ?`,
      [cutoff]
    );
    return result.changes;
  }

  async isFeedbackAlreadySent(agentId: string, collateralizationId: string): Promise<boolean> {
    const sql = `
      SELECT 1 FROM processed_entries
      WHERE agent_id = ? AND collateralization_id = ? AND feedback_sent_at IS NOT NULL
    `;
    const row = await this.get(sql, [agentId.toLowerCase(), collateralizationId]);
    return !!row;
  }

  async logError(
    component: string,
    message: string,
    details?: string,
    retryCount: number = 0
  ): Promise<void> {
    const sql = `
      INSERT INTO error_log (timestamp, component, message, details, retry_count)
      VALUES (?, ?, ?, ?, ?)
    `;
    const now = Math.floor(Date.now() / 1000);
    await this.run(sql, [now, component, message, details || null, retryCount]);
  }

  async startCycle(cycleId: string): Promise<void> {
    const now = Math.floor(Date.now() / 1000);
    const sql = `
      INSERT OR REPLACE INTO cycle_metrics (cycle_id, start_time, status)
      VALUES (?, ?, 'running')
    `;
    await this.run(sql, [cycleId, now]);
    logger.info('Cycle started', { cycleId });
  }

  async endCycle(
    cycleId: string,
    status: 'success' | 'partial' | 'failed',
    metrics: {
      totalEvents?: number;
      eligibleAgents?: number;
      feedbackSent?: number;
      errors?: number;
    }
  ): Promise<void> {
    const now = Math.floor(Date.now() / 1000);
    const sql = `
      UPDATE cycle_metrics
      SET end_time = ?,
          status = ?,
          total_events = COALESCE(?, total_events),
          eligible_agents = COALESCE(?, eligible_agents),
          feedback_sent = COALESCE(?, feedback_sent),
          errors = COALESCE(?, errors)
      WHERE cycle_id = ?
    `;
    await this.run(sql, [
      now,
      status,
      metrics.totalEvents ?? null,
      metrics.eligibleAgents ?? null,
      metrics.feedbackSent ?? null,
      metrics.errors ?? null,
      cycleId,
    ]);
    logger.info('Cycle ended', { cycleId, status, metrics });
  }

  async clearOldData(olderThanDays: number = 30): Promise<void> {
    const cutoff = Math.floor(Date.now() / 1000) - olderThanDays * 24 * 60 * 60;
    const sql = `
      DELETE FROM processed_entries
      WHERE feedback_sent_at IS NOT NULL AND feedback_sent_at < ?
    `;
    try {
      const result = await this.run(sql, [cutoff]);
      logger.info('Cleared old entries', { deleted: result.changes, cutoff });
    } catch (error) {
      logger.error('Failed to clear old data', { error });
      // Do not throw; cleanup is best-effort
    }
  }

  async getAgentsWithTrackedFeedback(): Promise<string[]> {
    const rows = await this.all(`
      SELECT DISTINCT agent_id
      FROM processed_entries
      WHERE feedback_sent_at IS NOT NULL AND revoked_at IS NULL
    `);
    return rows.map((row: any) => row.agent_id);
  }

  async hasActiveFeedbackForAgent(agentId: string): Promise<boolean> {
    const row = await this.get(
      `
        SELECT 1
        FROM processed_entries
        WHERE agent_id = ? AND feedback_sent_at IS NOT NULL AND revoked_at IS NULL
        LIMIT 1
      `,
      [agentId.toLowerCase()]
    );
    return Boolean(row);
  }

  async markAgentRevoked(agentId: string, txHash?: string): Promise<number> {
    const sql = `
      UPDATE processed_entries
      SET revoked_at = ?, revoked_tx_hash = COALESCE(?, revoked_tx_hash), status = 'revoked'
      WHERE agent_id = ? AND feedback_sent_at IS NOT NULL AND revoked_at IS NULL
    `;
    const now = Math.floor(Date.now() / 1000);
    const result = await this.run(sql, [now, txHash ?? null, agentId.toLowerCase()]);
    return result.changes ?? 0;
  }

  async close(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      if (!this.db) {
        resolve();
        return;
      }
      this.db.close((err: any) => {
        if (err) {
          reject(err);
        } else {
          logger.info('Database connection closed');
          this.db = null;
          resolve();
        }
      });
    });
  }
}

let globalStore: Store | null = null;
export function getStore(): Store {
  if (!globalStore) {
    globalStore = new Store();
  }
  return globalStore;
}
export async function resetStore(): Promise<void> {
  if (globalStore) {
    await globalStore.close();
    globalStore = null;
  }
}

// Compatibility aliases
export { getStore as getDatabase };
export { resetStore as resetDatabase };
export const store = new Store();
export type { Store as Database };
