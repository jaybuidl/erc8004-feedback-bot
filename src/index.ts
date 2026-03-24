import { getConfig } from './config';
import logger from './logger';
import { store } from './store';
import { goldskyClient } from './goldsky-client';
import { eligibilityEngine } from './eligibility';
import { feedbackSender } from './feedback';
import { walletManager } from './wallet';
import { metricsService } from './metrics';
import { runOnce } from './scheduler';
import type { OrchestratorStats, AgentFeedback } from './types';
import { buildFeedbackForEligibility } from './feedback-content';

// Re-export classes for test access
export { EligibilityEngine } from './eligibility';
export { GoldskyClient } from './goldsky-client';
export { FeedbackSender } from './feedback';
export { Store } from './store';

// Also keep existing exports (instances and functions)
export { store, goldskyClient, eligibilityEngine, feedbackSender, walletManager, metricsService, runOnce, orchestrateRun };

async function orchestrateRun(): Promise<OrchestratorStats> {
  const config = getConfig();
  const runId = `run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  logger.info('Starting bot run', { runId });

  const startTime = Date.now();
  let totalEvents = 0;
  let eligibleCount = 0;
  let feedbackSentCount = 0;
  let errorsCount = 0;

  try {
    // 1. Initialize components
    logger.debug('Initializing components');
    await walletManager.init();
    await store.init();
    // Reset any stale pending claims from previous crashed runs (1 hour timeout)
    await store.resetStaleClaims(3600);
    await feedbackSender.init();
    await metricsService.init();

    const signerAddress = await feedbackSender.getSignerAddress();

    // 2. Fetch current active events from Goldsky
    let events;
    try {
      events = await goldskyClient.fetchCurrentActiveCollateralizations();
      totalEvents = events.length;
      logger.info('Fetched current active collateralization events', { count: totalEvents });
    } catch (error) {
      logger.error('Failed to fetch from Goldsky', { error: error as Error });
      metricsService.recordError('goldsky');
      errorsCount++;
      throw error;
    }

    // 3. Persist events to DB (upsert)
    try {
      for (const event of events) {
        await store.upsertCollateralization(event);
      }
      logger.debug('Events persisted to database', { count: events.length });
    } catch (error) {
      logger.error('Database upsert failed', { error: error as Error });
      metricsService.recordError('database');
      errorsCount++;
      throw error;
    }

    // 4. Revoke feedback for agents that are no longer actively collateralized
    if (config.REVOKE_ON_ABSENCE) {
      try {
        const activeAgents = new Set(events.map((event) => event.agent.toLowerCase()));
        const trackedAgents = await store.getAgentsWithTrackedFeedback();

        for (const agentId of trackedAgents) {
          if (activeAgents.has(agentId.toLowerCase())) {
            continue;
          }

          const activeFeedback = await feedbackSender.listOwnFeedback(agentId);
          const unrevoked = activeFeedback.filter((entry) => !entry.revoked);
          if (unrevoked.length === 0) {
            if (!config.DRY_RUN) {
              await store.markAgentRevoked(agentId);
            }
            continue;
          }

          logger.info('Revoking feedback for no-longer-active agent', {
            agentId,
            feedbackIndexes: unrevoked.map((entry) => entry.feedbackIndex),
          });

          let revocationFailed = false;
          let lastTxHash: string | undefined;
          for (const entry of unrevoked) {
            const result = await feedbackSender.revokeFeedback(agentId, entry.feedbackIndex);
            if (!result.success) {
              revocationFailed = true;
              metricsService.recordError('feedback');
              errorsCount++;
            } else {
              lastTxHash = result.txHash;
            }
          }

          if (!revocationFailed && !config.DRY_RUN) {
            await store.markAgentRevoked(agentId, lastTxHash);
          }
        }
      } catch (error) {
        logger.error('Revocation pass failed', { error: error as Error });
        metricsService.recordError('feedback');
        errorsCount++;
        throw error;
      }
    }

    // 5. Determine eligibility
    let eligible;
    try {
      eligible = eligibilityEngine.filterEligible(events, config.CHAIN_ID);
      eligibleCount = eligible.length;
      logger.info('Eligible agents determined', { count: eligibleCount });
    } catch (error) {
      logger.error('Eligibility engine failed', { error: error as Error });
      metricsService.recordError('eligibility');
      errorsCount++;
      throw error;
    }

    if (eligible.length === 0) {
      logger.info('No eligible agents, run complete');
      const stats: OrchestratorStats = {
        totalEvents,
        eligibleAgents: 0,
        feedbackSent: 0,
        errorsCount,
        runId,
        durationMs: Date.now() - startTime,
      };
      metricsService.recordRun(stats, true);
      // Cleanup old data even on early exit
      await store.clearOldData(30);
      return stats;
    }

    // 5.5. Mark eligible agents in the store (so they are recognized as eligible for deduplication)
    try {
      for (const e of eligible) {
        await store.markEligible(e.agent, e.collateralizationId);
      }
      logger.debug('Marked agents as eligible in store', { count: eligible.length });
    } catch (error) {
      logger.error('Failed to mark agents as eligible', { error: error as Error });
      metricsService.recordError('database');
      errorsCount++;
      throw error;
    }

    // 6. Atomically claim eligible work to avoid duplicates
    try {
      const claimed = await store.claimEligibleWork(eligibleCount);
      logger.info('Work claim results', {
        totalEligible: eligibleCount,
        claimed: claimed.length,
      });
      eligible = claimed;
    } catch (error) {
      logger.error('Failed to claim eligible work', { error: error as Error });
      metricsService.recordError('database');
      errorsCount++;
      throw error;
    }

    if (eligible.length === 0) {
      logger.info('No eligible agents to process after claim');
      const stats: OrchestratorStats = {
        totalEvents,
        eligibleAgents: eligibleCount,
        feedbackSent: 0,
        errorsCount,
        runId,
        durationMs: Date.now() - startTime,
      };
      metricsService.recordRun(stats, true);
      // Cleanup old data even on early exit
      await store.clearOldData(30);
      return stats;
    }

    // 7. Reconcile against the chain and prepare feedback payloads
    const preparedFeedback: Array<{ eligibility: typeof eligible[number]; feedback: AgentFeedback }> = [];
    for (const entry of eligible) {
      const feedback = buildFeedbackForEligibility(entry, signerAddress);

      if (config.ONCHAIN_DUPLICATE_PROTECTION) {
        const matchingIndices = await feedbackSender.findMatchingActiveFeedbackIndices(entry.agent, {
          value: feedback.value,
          decimals: feedback.decimals,
          tag1: feedback.tag1,
          tag2: feedback.tag2,
        });

        if (matchingIndices.length > 0) {
          logger.info('Skipping feedback because matching active feedback already exists on-chain', {
            agentId: entry.agent,
            collateralizationId: entry.collateralizationId,
            feedbackIndexes: matchingIndices,
          });

          if (!config.DRY_RUN) {
            await store.markFeedbackTracked(
              entry.agent,
              entry.collateralizationId,
              Math.max(...matchingIndices)
            );
          }
          continue;
        }
      }

      preparedFeedback.push({ eligibility: entry, feedback });
    }

    if (preparedFeedback.length === 0) {
      logger.info('No eligible agents require new feedback after on-chain reconciliation');
      const stats: OrchestratorStats = {
        totalEvents,
        eligibleAgents: eligibleCount,
        feedbackSent: 0,
        errorsCount,
        runId,
        durationMs: Date.now() - startTime,
      };
      metricsService.recordRun(stats, true);
      await store.clearOldData(30);
      return stats;
    }

    // Split into batches
    const batchSize = config.MAX_BATCH_SIZE;
    for (let i = 0; i < preparedFeedback.length; i += batchSize) {
      const batchEntries = preparedFeedback.slice(i, i + batchSize);
      const batch = batchEntries.map((entry) => entry.feedback);
      logger.info('Sending feedback batch', {
        batchIndex: Math.floor(i / batchSize) + 1,
        batchSize: batch.length,
        totalBatches: Math.ceil(preparedFeedback.length / batchSize),
      });

      const results = await feedbackSender.sendBatch(batch);

      // Record each result in DB (skip marking in dry-run to avoid side-effects)
      for (let j = 0; j < batch.length; j++) {
        const result = results[j];
        const eligibleEntry = batchEntries[j].eligibility;

        if (result.success && result.txHash) {
          if (!config.DRY_RUN) {
            await store.markFeedbackSent(
              eligibleEntry.agent,
              eligibleEntry.collateralizationId,
              result.txHash!,
              result.feedbackIndex
            );
            feedbackSentCount++;
            logger.debug('Feedback recorded', {
              agent: eligibleEntry.agent,
              txHash: result.txHash,
              feedbackIndex: result.feedbackIndex,
              dryRun: config.DRY_RUN,
            });
          } else {
            logger.debug('[DRY RUN] Skipping feedback recording', {
              agent: eligibleEntry.agent,
              txHash: result.txHash,
            });
          }
        } else {
          logger.error('Feedback send failed for agent', {
            agent: eligibleEntry.agent,
            error: result.error?.message,
          });
          metricsService.recordError('feedback');
          errorsCount++;
        }
      }

      // Only record feedback sent metric when not in dry-run (actual sends only)
      if (!config.DRY_RUN) {
        metricsService.recordFeedbackSent(results.filter((r) => r.success).length);
      }
      metricsService.recordTransaction(config.DRY_RUN ? 'dry-run' : 'success');

      // Small pause between batches
      if (i + batchSize < preparedFeedback.length) {
        await new Promise((resolve) => setTimeout(resolve, config.BATCH_PAUSE_MS));
      }
    }

    logger.info('Bot run completed successfully', {
      totalEvents,
      eligibleCount,
      feedbackSentCount,
      errorsCount,
      durationMs: Date.now() - startTime,
    });

    const stats: OrchestratorStats = {
      totalEvents,
      eligibleAgents: eligibleCount,
      feedbackSent: feedbackSentCount,
      errorsCount,
      runId,
      durationMs: Date.now() - startTime,
    };
    metricsService.recordRun(stats, errorsCount === 0);

    // Optional: prune old data
    try {
      await store.clearOldData(30);
    } catch (error) {
      logger.warn('Failed to prune old data', { error: error as Error });
    }

    return stats;
  } catch (error) {
    // Log detailed error for debugging
    console.error('Bot run failed catastrophically', error);
    logger.error('Bot run failed catastrophically', {
      message: (error as any)?.message || String(error),
      stack: (error as any)?.stack,
      code: (error as any)?.code,
      errno: (error as any)?.errno,
    });
    metricsService.recordError('unknown');
    const stats: OrchestratorStats = {
      totalEvents,
      eligibleAgents: eligibleCount,
      feedbackSent: feedbackSentCount,
      errorsCount: errorsCount + 1,
      runId,
      durationMs: Date.now() - startTime,
    };
    metricsService.recordRun(stats, false);
    throw error;
  }
}

// If run directly (node dist/index.js), execute once and exit
if (require.main === module) {
  runOnce(orchestrateRun)
    .then(() => {
      logger.info('Bot exiting normally');
      process.exit(0);
    })
    .catch((error) => {
      logger.error('Bot exiting with error', { error: error as Error });
      process.exit(1);
    });
}
