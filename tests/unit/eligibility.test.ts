import { EligibilityEngine } from '../../src/eligibility';
import { resetConfig } from '../../src/config';
import type { CollateralizationEvent } from '../../src/types';

describe('EligibilityEngine', () => {
  const engine = new EligibilityEngine();

  const now = Math.floor(Date.now() / 1000);
  const fourDaysAgo = now - 4 * 24 * 60 * 60; // >72h
  const twoDaysAgo = now - 2 * 24 * 60 * 60; // <72h
  const fiveDaysAgo = now - 5 * 24 * 60 * 60;
  const threeDaysAgo = now - 3 * 24 * 60 * 60;

  const createEvent = (
    id: string,
    agent: string,
    status: CollateralizationEvent['status'],
    timestamp: number,
    pgtcrId: number = 1
  ): CollateralizationEvent => ({
    id,
    agent,
    amount: 1000n,
    status,
    timestamp,
    pgtcrId,
  });

  test('should identify agent with continuous registered >72h as eligible', () => {
    const events: CollateralizationEvent[] = [
      createEvent('e1', '0xagent1', 'registered', fourDaysAgo),
    ];

    const eligible = engine.filterEligible(events, 1, now);
    expect(eligible).toHaveLength(1);
    expect(eligible[0].agent).toBe('0xagent1');
    expect(eligible[0].collateralizationId).toBe('e1');
  });

  test('should not identify agent registered <72h ago', () => {
    const events: CollateralizationEvent[] = [
      createEvent('e1', '0xagent1', 'registered', twoDaysAgo),
    ];

    const eligible = engine.filterEligible(events, 1, now);
    expect(eligible).toHaveLength(0);
  });

  test('should not identify agent who withdrew after being active', () => {
    const events: CollateralizationEvent[] = [
      createEvent('e1', '0xagent1', 'registered', fourDaysAgo),
      createEvent('e2', '0xagent1', 'withdrawn', twoDaysAgo),
    ];

    const eligible = engine.filterEligible(events, 1, now);
    expect(eligible).toHaveLength(0);
  });

  test('should identify agent still active after >72h', () => {
    const events: CollateralizationEvent[] = [
      createEvent('e1', '0xagent1', 'registered', fourDaysAgo),
    ];

    const eligible = engine.filterEligible(events, 1, now);
    expect(eligible).toHaveLength(1);
  });

  test('should handle multiple agents correctly', () => {
    const events: CollateralizationEvent[] = [
      createEvent('e1', '0xagent1', 'registered', fourDaysAgo),
      createEvent('e2', '0xagent2', 'registered', twoDaysAgo),
      createEvent('e3', '0xagent3', 'registered', fiveDaysAgo),
    ];

    const eligible = engine.filterEligible(events, 1, now);
    expect(eligible).toHaveLength(2);
    expect(eligible.map((a) => a.agent).sort()).toEqual(['0xagent1', '0xagent3']);
  });

  test('should handle re-registration after withdrawal', () => {
    const events: CollateralizationEvent[] = [
      createEvent('e1', '0xagent1', 'registered', fiveDaysAgo),
      createEvent('e2', '0xagent1', 'withdrawn', threeDaysAgo),
      createEvent('e3', '0xagent1', 'registered', twoDaysAgo),
    ];

    const eligible = engine.filterEligible(events, 1, now);
    expect(eligible).toHaveLength(0);
  });

  test('should handle re-registration after withdrawal becomes eligible', () => {
    const base = now - 10 * 24 * 60 * 60; // 10 days ago
    const events: CollateralizationEvent[] = [
      createEvent('e1', '0xagent1', 'registered', base),
      createEvent('e2', '0xagent1', 'withdrawn', base + 2 * 24 * 60 * 60),
      createEvent('e3', '0xagent1', 'registered', base + 3 * 24 * 60 * 60),
    ];
    const eligible = engine.filterEligible(events, 1, now);
    expect(eligible).toHaveLength(1);
    expect(eligible[0].agent).toBe('0xagent1');
    expect(eligible[0].collateralizationId).toBe('e3');
  });

  test('should respect the configured threshold', () => {
    const sixDaysAgo = now - 6 * 24 * 60 * 60;
    const fourDaysAgo = now - 4 * 24 * 60 * 60;

    const events: CollateralizationEvent[] = [
      createEvent('e1', '0xagent1', 'registered', sixDaysAgo),
      createEvent('e2', '0xagent2', 'registered', fourDaysAgo),
    ];

    process.env.MIN_AGE_HOURS = '120';
    resetConfig();

    const eligible = engine.filterEligible(events, 1, now);
    expect(eligible).toHaveLength(1);
    expect(eligible[0].agent).toBe('0xagent1');
    expect(eligible[0].collateralizationId).toBe('e1');

    process.env.MIN_AGE_HOURS = '72';
    resetConfig();
  });

  test('should support decimal MIN_AGE_HOURS thresholds', () => {
    const fortyMinutesAgo = now - 40 * 60;
    const twentyMinutesAgo = now - 20 * 60;

    const events: CollateralizationEvent[] = [
      createEvent('e1', '0xagent1', 'registered', fortyMinutesAgo),
      createEvent('e2', '0xagent2', 'registered', twentyMinutesAgo),
    ];

    process.env.MIN_AGE_HOURS = '0.5';
    resetConfig();

    const eligible = engine.filterEligible(events, 1, now);
    expect(eligible).toHaveLength(1);
    expect(eligible[0].agent).toBe('0xagent1');
    expect(eligible[0].collateralizationId).toBe('e1');

    process.env.MIN_AGE_HOURS = '72';
    resetConfig();
  });
});
