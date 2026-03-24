import logger from './logger';

// The production model is external scheduling plus a one-shot process.
export async function runOnce(runTask: () => Promise<any>): Promise<void> {
  const startTime = Date.now();
  logger.info('Manual run triggered', { runId: `manual-${Date.now()}` });

  try {
    await runTask();
    const duration = Date.now() - startTime;
    logger.info('Manual run completed', { durationMs: duration });
  } catch (error) {
    logger.error('Manual run failed', { error: error as Error });
    throw error;
  }
}
