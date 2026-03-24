import { orchestrateRun } from '../../src/index';
import { goldskyClient } from '../../src/goldsky-client';
import { eligibilityEngine } from '../../src/eligibility';
import { store } from '../../src/store';
import { feedbackSender } from '../../src/feedback';
import { getConfig } from '../../src/config';
import { metricsService } from '../../src/metrics';
import { walletManager } from '../../src/wallet';

jest.mock('../../src/logger', () => ({
  info: jest.fn(),
  debug: jest.fn(),
  error: jest.fn(),
  warn: jest.fn(),
}));

jest.mock('../../src/goldsky-client', () => ({
  goldskyClient: {
    fetchCurrentActiveCollateralizations: jest.fn(),
  },
}));

jest.mock('../../src/eligibility', () => ({
  eligibilityEngine: {
    filterEligible: jest.fn(),
  },
}));

jest.mock('../../src/store', () => ({
  store: {
    init: jest.fn(),
    resetStaleClaims: jest.fn().mockResolvedValue(0),
    upsertCollateralization: jest.fn(),
    getAgentsWithTrackedFeedback: jest.fn().mockResolvedValue([]),
    markAgentRevoked: jest.fn().mockResolvedValue(0),
    markEligible: jest.fn().mockResolvedValue(undefined),
    claimEligibleWork: jest.fn(),
    markFeedbackSent: jest.fn().mockResolvedValue(undefined),
    markFeedbackTracked: jest.fn().mockResolvedValue(undefined),
    clearOldData: jest.fn().mockResolvedValue(undefined),
  },
}));

jest.mock('../../src/feedback', () => ({
  feedbackSender: {
    init: jest.fn(),
    getSignerAddress: jest.fn().mockResolvedValue('0xbot'),
    listOwnFeedback: jest.fn().mockResolvedValue([]),
    revokeFeedback: jest.fn(),
    findMatchingActiveFeedbackIndices: jest.fn().mockResolvedValue([]),
    sendBatch: jest.fn(),
  },
}));

jest.mock('../../src/wallet', () => ({
  walletManager: {
    init: jest.fn(),
  },
}));

jest.mock('../../src/metrics', () => ({
  metricsService: {
    init: jest.fn(),
    recordRun: jest.fn(),
    recordFeedbackSent: jest.fn(),
    recordTransaction: jest.fn(),
    recordError: jest.fn(),
  },
}));

const mockConfig = {
  FEEDBACK_VALUE: 100,
  FEEDBACK_DECIMALS: 0,
  FEEDBACK_TAG1: 'pgtcr_active',
  FEEDBACK_TAG2: 'sepolia_testnet',
  FEEDBACK_ENDPOINT: 'erc8004://feedback',
  FEEDBACK_URI: '',
  FEEDBACK_HASH: '',
  FEEDBACK_TITLE_TEMPLATE: 'PGTCR active',
  FEEDBACK_TEXT_TEMPLATE: 'Agent {{agentIdDecimal}} is active',
  FEEDBACK_URI_MODE: 'generated',
  FEEDBACK_EXTRA_JSON: {},
  MAX_BATCH_SIZE: 10,
  FEEDBACK_BATCH_INTERVAL_MS: 0,
  BATCH_PAUSE_MS: 0,
  DRY_RUN: false,
  ENABLE_METRICS: false,
  CHAIN_ID: 11155111,
  MIN_AGE_HOURS: 72,
  MIN_AGE_SECONDS: 259200,
  REVOKE_ON_ABSENCE: true,
  ONCHAIN_DUPLICATE_PROTECTION: true,
  ONCHAIN_FEEDBACK_SCAN_LIMIT: 20,
  GAS_BUFFER_MULTIPLIER: 120,
  currentChain: 'sepolia',
};

jest.mock('../../src/config', () => ({
  getConfig: jest.fn(),
  resetConfig: jest.fn(),
}));

describe('orchestrateRun', () => {
  const mockEvents = [
    {
      id: 'evt-1',
      agent: '0x0000000000000000000000000000000000000000000000000000000000000123',
      amount: 100n,
      status: 'registered' as const,
      timestamp: 1700000000,
      pgtcrId: 1,
    },
  ];

  const mockEligible = [
    {
      agent: mockEvents[0].agent,
      collateralizationId: mockEvents[0].id,
      collateralizationSince: mockEvents[0].timestamp,
      pgtcrId: 1,
      amount: 100n,
      chainId: 11155111,
    },
  ];

  beforeEach(() => {
    jest.clearAllMocks();
    (getConfig as jest.Mock).mockReturnValue(mockConfig);
    (walletManager.init as jest.Mock).mockResolvedValue(undefined);
    (store.init as jest.Mock).mockResolvedValue(undefined);
    (store.resetStaleClaims as jest.Mock).mockResolvedValue(0);
    (store.getAgentsWithTrackedFeedback as jest.Mock).mockResolvedValue([]);
    (store.markAgentRevoked as jest.Mock).mockResolvedValue(0);
    (store.markEligible as jest.Mock).mockResolvedValue(undefined);
    (store.markFeedbackSent as jest.Mock).mockResolvedValue(undefined);
    (store.markFeedbackTracked as jest.Mock).mockResolvedValue(undefined);
    (store.clearOldData as jest.Mock).mockResolvedValue(undefined);
    (feedbackSender.init as jest.Mock).mockResolvedValue(undefined);
    (feedbackSender.getSignerAddress as jest.Mock).mockResolvedValue('0xbot');
    (feedbackSender.listOwnFeedback as jest.Mock).mockResolvedValue([]);
    (feedbackSender.findMatchingActiveFeedbackIndices as jest.Mock).mockResolvedValue([]);
    (metricsService.init as jest.Mock).mockResolvedValue(undefined);
    (goldskyClient.fetchCurrentActiveCollateralizations as jest.Mock).mockResolvedValue(mockEvents);
    (eligibilityEngine.filterEligible as jest.Mock).mockReturnValue(mockEligible);
    (store.claimEligibleWork as jest.Mock).mockResolvedValue(mockEligible);
    (feedbackSender.sendBatch as jest.Mock).mockResolvedValue([
      { success: true, txHash: '0xtx', feedbackIndex: 4, agentId: mockEvents[0].agent },
    ]);
  });

  it('sends feedback for newly eligible agents', async () => {
    const result = await orchestrateRun();

    expect(walletManager.init).toHaveBeenCalled();
    expect(store.upsertCollateralization).toHaveBeenCalledWith(mockEvents[0]);
    expect(store.markEligible).toHaveBeenCalledWith(mockEligible[0].agent, mockEligible[0].collateralizationId);
    expect(feedbackSender.sendBatch).toHaveBeenCalledTimes(1);
    expect(store.markFeedbackSent).toHaveBeenCalledWith(
      mockEligible[0].agent,
      mockEligible[0].collateralizationId,
      '0xtx',
      4
    );
    expect(result.feedbackSent).toBe(1);
  });

  it('skips sending when matching active feedback already exists on-chain', async () => {
    (feedbackSender.findMatchingActiveFeedbackIndices as jest.Mock).mockResolvedValue([2]);

    const result = await orchestrateRun();

    expect(feedbackSender.sendBatch).not.toHaveBeenCalled();
    expect(store.markFeedbackTracked).toHaveBeenCalledWith(
      mockEligible[0].agent,
      mockEligible[0].collateralizationId,
      2
    );
    expect(result.feedbackSent).toBe(0);
  });

  it('revokes tracked feedback when an agent disappears from the active set', async () => {
    (goldskyClient.fetchCurrentActiveCollateralizations as jest.Mock).mockResolvedValue([]);
    (eligibilityEngine.filterEligible as jest.Mock).mockReturnValue([]);
    (store.getAgentsWithTrackedFeedback as jest.Mock).mockResolvedValue([mockEligible[0].agent]);
    (feedbackSender.listOwnFeedback as jest.Mock).mockResolvedValue([
      {
        feedbackIndex: 1,
        value: '100',
        decimals: 0,
        tag1: 'pgtcr_active',
        tag2: 'sepolia_testnet',
        revoked: false,
      },
    ]);
    (feedbackSender.revokeFeedback as jest.Mock).mockResolvedValue({
      success: true,
      txHash: '0xrevoke',
      feedbackIndex: 1,
      agentId: mockEligible[0].agent,
    });
    (store.claimEligibleWork as jest.Mock).mockResolvedValue([]);

    await orchestrateRun();

    expect(feedbackSender.revokeFeedback).toHaveBeenCalledWith(mockEligible[0].agent, 1);
    expect(store.markAgentRevoked).toHaveBeenCalledWith(mockEligible[0].agent, '0xrevoke');
  });
});
