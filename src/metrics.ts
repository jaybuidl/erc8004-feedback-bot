import client from 'prom-client';
import { getConfig } from './config';
import logger from './logger';
import type { OrchestratorStats } from './types';

export class MetricsService {
  private server: any | null = null;
  private initialized = false;

  // Define metrics
  readonly runsTotal = new client.Counter({
    name: 'erc8004_bot_runs_total',
    help: 'Total number of bot runs',
    labelNames: ['status'], // success, failure
  });

  readonly runDuration = new client.Histogram({
    name: 'erc8004_bot_run_duration_seconds',
    help: 'Duration of bot run in seconds',
    labelNames: [],
    buckets: [30, 60, 120, 180, 300, 600], // up to 10min
  });

  readonly eligibleAgents = new client.Gauge({
    name: 'erc8004_eligible_agents_total',
    help: 'Number of eligible agents in last run',
    labelNames: [],
  });

  readonly feedbackSent = new client.Counter({
    name: 'erc8004_feedback_sent_total',
    help: 'Total feedback entries sent',
    labelNames: [],
  });

  readonly transactionsSent = new client.Counter({
    name: 'erc8004_transactions_sent_total',
    help: 'Total transactions submitted to chain',
    labelNames: ['status'], // success, failed, dry-run
  });

  readonly errorsTotal = new client.Counter({
    name: 'erc8004_errors_total',
    help: 'Total errors encountered',
    labelNames: ['type'], // goldsky, database, mapper, feedback, unknown
  });

  async init(): Promise<void> {
    if (this.initialized) {return;}

    const config = getConfig();

    if (!config.ENABLE_METRICS) {
      logger.debug('Metrics disabled by config');
      return;
    }

    try {
      // Clear any existing default metrics
      client.register.clear();

      // Register our metrics
      client.register.registerMetric(this.runsTotal);
      client.register.registerMetric(this.runDuration);
      client.register.registerMetric(this.eligibleAgents);
      client.register.registerMetric(this.feedbackSent);
      client.register.registerMetric(this.transactionsSent);
      client.register.registerMetric(this.errorsTotal);

      // Create express server
      // @ts-expect-error - express types may not be installed, but we use any
      const express = (await import('express')).default;
      const app = express();

      app.get('/metrics', async (_req: any, res: any) => {
        void _req;
        try {
          res.set('Content-Type', client.register.contentType);
          res.end(await client.register.metrics());
        } catch (err) {
          logger.error('Error generating metrics', { error: (err as Error).message });
          res.status(500).end(err as any);
        }
      });

      app.get('/health', (_req: any, res: any) => {
        void _req;
        res.json({ status: 'ok', timestamp: new Date().toISOString() });
      });

      this.initialized = true;

      try {
        this.server = await new Promise<any>((resolve, reject) => {
          const server = app.listen(config.METRICS_PORT, () => resolve(server));
          server.once('error', reject);
        });

        logger.info('Metrics server started', {
          port: config.METRICS_PORT,
          url: `http://localhost:${config.METRICS_PORT}/metrics`,
        });
      } catch (error) {
        this.server = null;
        logger.warn('Failed to bind metrics server; continuing without HTTP metrics endpoint', {
          error: error as Error,
          port: config.METRICS_PORT,
        });
      }
    } catch (error) {
      logger.error('Failed to start metrics server', { error: error as Error });
      // Don't throw - metrics should not crash the bot
    }
  }

  recordRun(stats: OrchestratorStats, success: boolean): void {
    const status = success ? 'success' : 'failure';
    this.runsTotal.inc({ status });

    const durationSeconds = stats.durationMs / 1000;
    this.runDuration.observe(durationSeconds);

    if (stats.eligibleAgents !== undefined) {
      this.eligibleAgents.set(stats.eligibleAgents);
    }
  }

  recordFeedbackSent(count: number): void {
    this.feedbackSent.inc(count);
  }

  recordTransaction(status: 'success' | 'failed' | 'dry-run'): void {
    this.transactionsSent.inc({ status });
  }

  recordError(type: string): void {
    this.errorsTotal.inc({ type });
  }

  async shutdown(): Promise<void> {
    if (this.server) {
      await new Promise((resolve) => this.server!.close(() => resolve(null)));
      logger.info('Metrics server stopped');
    }
    this.initialized = false;
  }
}

export const metricsService = new MetricsService();
