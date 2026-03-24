import type { CollateralizationEvent } from '../../src/types';

// Use a fixed reference timestamp for deterministic tests
export const FIXED_NOW = 1742326000; // 2025-03-19 00:00:00 UTC (adjust as needed)

export const sampleCollateralizationEvents: CollateralizationEvent[] = [
  {
    id: '0x1234567890abcdef1234567890abcdef12345678',
    agent: '0x1111111111111111111111111111111111111111',
    amount: 1000000000000000000n, // 1 ETH
    status: 'registered',
    timestamp: FIXED_NOW - 4 * 24 * 60 * 60, // 4 days ago
    pgtcrId: 1,
  },
  {
    id: '0x2345678901abcdef2345678901abcdef23456789',
    agent: '0x2222222222222222222222222222222222222222',
    amount: 2000000000000000000n, // 2 ETH
    status: 'registered',
    timestamp: FIXED_NOW - 5 * 24 * 60 * 60, // 5 days ago
    pgtcrId: 1,
  },
  {
    id: '0x3456789012abcdef3456789012abcdef34567890',
    agent: '0x3333333333333333333333333333333333333333',
    amount: 500000000000000000n, // 0.5 ETH
    status: 'withdrawn',
    timestamp: FIXED_NOW - 2 * 24 * 60 * 60, // 2 days ago
    pgtcrId: 1,
  },
  {
    id: '0x4567890123abcdef4567890123abcdef45678901',
    agent: '0x4444444444444444444444444444444444444444',
    amount: 1500000000000000000n, // 1.5 ETH
    status: 'registered',
    timestamp: FIXED_NOW - 1 * 24 * 60 * 60, // 1 day ago - NOT eligible
    pgtcrId: 1,
  },
  {
    id: '0x5678901234abcdef5678901234abcdef56789012',
    agent: '0x5555555555555555555555555555555555555555',
    amount: 3000000000000000000n, // 3 ETH
    status: 'challenged',
    timestamp: FIXED_NOW - 10 * 24 * 60 * 60, // 10 days ago, challenged
    pgtcrId: 2,
  },
  {
    id: '0x6789012345abcdef6789012345abcdef67890123',
    agent: '0x6666666666666666666666666666666666666666',
    amount: 1000000000000000000n, // 1 ETH
    status: 'registered',
    timestamp: FIXED_NOW - 7 * 24 * 60 * 60, // 7 days ago, still active (eligible)
    pgtcrId: 2,
  },
];

export const sampleEligibleAgents = [
  {
    agent: '0x1111111111111111111111111111111111111111',
    collateralizationId: '0x1234567890abcdef1234567890abcdef12345678',
    collateralizationSince: FIXED_NOW - 4 * 24 * 60 * 60,
    pgtcrId: 1,
    amount: 1000000000000000000n,
  },
  {
    agent: '0x2222222222222222222222222222222222222222',
    collateralizationId: '0x2345678901abcdef2345678901abcdef23456789',
    collateralizationSince: FIXED_NOW - 5 * 24 * 60 * 60,
    pgtcrId: 1,
    amount: 2000000000000000000n,
  },
  {
    agent: '0x6666666666666666666666666666666666666666',
    collateralizationId: '0x6789012345abcdef6789012345abcdef67890123',
    collateralizationSince: FIXED_NOW - 7 * 24 * 60 * 60,
    pgtcrId: 2,
    amount: 1000000000000000000n,
  },
];
