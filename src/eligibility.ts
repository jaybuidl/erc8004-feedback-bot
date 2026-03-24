import logger from './logger';
import { getConfig } from './config';
import type { CollateralizationEvent, AgentEligibility } from './types';

export class EligibilityEngine {
  /**
   * Processes a list of collateralization events for an agent and returns
   * those that satisfy the continuous active period > threshold.
   *
   * Logic:
   * - Sort events by timestamp ascending
   * - Track current active period: starts with a 'registered' event
   * - If a 'withdrawn' or 'challenged' appears, close current period
   * - For each period, if (now - period_start) > threshold, eligible
   *
   * @param events - List of collateralization events
   * @param chainId - Chain ID for the eligibility result
   * @param now - Current timestamp in seconds (defaults to Date.now()/1000)
   */
  filterEligible(
    events: CollateralizationEvent[],
    chainId: number,
    now?: number
  ): AgentEligibility[] {
    logger.debug('Evaluating eligibility', { totalEvents: events.length });
    const currentTime = now ?? Math.floor(Date.now() / 1000);

    // Use threshold from config (MIN_AGE_SECONDS derived from MIN_AGE_HOURS or MIN_ACTIVE_DAYS)
    const config = getConfig();
    const thresholdSeconds = config.MIN_AGE_SECONDS;

    // Group by agent
    const byAgent = new Map<string, CollateralizationEvent[]>();
    for (const event of events) {
      const list = byAgent.get(event.agent) ?? [];
      list.push(event);
      byAgent.set(event.agent, list);
    }

    const eligible: AgentEligibility[] = [];

    for (const [agent, agentEvents] of byAgent.entries()) {
      // Sort by timestamp ascending
      agentEvents.sort((a, b) => a.timestamp - b.timestamp);

      let periodStart: number | null = null;
      let hasActiveFlag = false;
      let activeCollateralizationId: string | null = null;

      for (const event of agentEvents) {
        if (event.status === 'registered') {
          // Start or continue active period
          if (!hasActiveFlag) {
            periodStart = event.timestamp;
            activeCollateralizationId = event.id;
            hasActiveFlag = true;
          }
          // If already active, keep earliest period start and collateralization ID
        } else if (event.status === 'withdrawn' || event.status === 'challenged') {
          // End the active period; do not push eligibility because agent is no longer active
          hasActiveFlag = false;
          periodStart = null;
          activeCollateralizationId = null;
        }
      }

      // Handle if still active at now (no withdrawing event observed)
      if (hasActiveFlag && periodStart !== null && activeCollateralizationId) {
        const duration = currentTime - periodStart;
        if (duration > thresholdSeconds) {
          // Find the registration event for this period to get pgtcrId and amount
          const registrationEvent = agentEvents.find(
            (e) => e.id === activeCollateralizationId
          );
          eligible.push({
            agent,
            collateralizationId: activeCollateralizationId,
            collateralizationSince: periodStart,
            pgtcrId: registrationEvent?.pgtcrId ?? 0,
            amount: registrationEvent?.amount ?? 0n,
            chainId,
          });
          logger.debug('Agent eligible (still active)', {
            agent,
            collateralizationId: activeCollateralizationId,
            durationDays: duration / 86400,
          });
        }
      }
    }

    logger.info('Eligibility filter complete', { eligibleCount: eligible.length });
    return eligible;
  }
}

export const eligibilityEngine = new EligibilityEngine();
export type EligibilityEngineType = EligibilityEngine;
