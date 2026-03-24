import { ethers } from 'ethers';
import { FeedbackSender } from '../../src/feedback';
import { getConfig } from '../../src/config';
import { walletManager } from '../../src/wallet';

jest.mock('../../src/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
}));

var mockConfig: any = {
  REPUTATION_REGISTRY_ADDRESS: '0x2222222222222222222222222222222222222222',
  FEEDBACK_VALUE: 100,
  FEEDBACK_DECIMALS: 0,
  FEEDBACK_TAG1: 'pgtcr_active',
  FEEDBACK_TAG2: 'sepolia_testnet',
  FEEDBACK_ENDPOINT: 'erc8004://feedback',
  FEEDBACK_URI: '',
  FEEDBACK_HASH: '',
  FEEDBACK_BATCH_INTERVAL_MS: 0,
  GAS_BUFFER_MULTIPLIER: 120,
  ONCHAIN_FEEDBACK_SCAN_LIMIT: 20,
  DRY_RUN: false,
};

jest.mock('../../src/config', () => ({
  getConfig: jest.fn(),
  resetConfig: jest.fn(),
}));

const signerAddress = '0x1111111111111111111111111111111111111111';
const mockSigner = {
  getAddress: jest.fn().mockResolvedValue(signerAddress),
};

jest.mock('../../src/wallet', () => ({
  walletManager: {
    init: jest.fn(),
    getSigner: jest.fn(),
  },
}));

describe('FeedbackSender', () => {
  let sender: FeedbackSender;
  let mockContract: any;

  beforeEach(() => {
    jest.clearAllMocks();
    mockConfig.DRY_RUN = false;
    (getConfig as jest.Mock).mockReturnValue(mockConfig);
    (walletManager.init as jest.Mock).mockResolvedValue(undefined);
    (walletManager.getSigner as jest.Mock).mockReturnValue(mockSigner);
    mockSigner.getAddress.mockResolvedValue(signerAddress);

    mockContract = {
      interface: {
        parseLog: jest.fn(),
      },
      getLastIndex: jest.fn().mockResolvedValue(0n),
      readFeedback: jest.fn(),
      giveFeedback: jest.fn().mockResolvedValue({
        hash: '0xtxhash',
        wait: jest.fn().mockResolvedValue({
          hash: '0xreceipt',
          blockNumber: 123,
          gasUsed: 21000n,
          logs: [{}],
        }),
      }),
      revokeFeedback: jest.fn().mockResolvedValue({
        hash: '0xrevoketx',
        wait: jest.fn().mockResolvedValue({
          hash: '0xrevokereceipt',
          blockNumber: 124,
          gasUsed: 18000n,
          logs: [],
        }),
      }),
    };
    mockContract.giveFeedback.estimateGas = jest.fn().mockResolvedValue(21000n);
    mockContract.revokeFeedback.estimateGas = jest.fn().mockResolvedValue(18000n);

    jest.spyOn(ethers, 'Contract').mockImplementation(() => mockContract as any);

    sender = new FeedbackSender();
  });

  it('initializes signer and contract once', async () => {
    await sender.init();
    await sender.init();

    expect(walletManager.init).toHaveBeenCalledTimes(1);
    expect(walletManager.getSigner).toHaveBeenCalledTimes(1);
    expect(ethers.Contract).toHaveBeenCalledWith(
      mockConfig.REPUTATION_REGISTRY_ADDRESS,
      expect.any(Array),
      mockSigner
    );
  });

  it('sends feedback and extracts feedbackIndex from the receipt event', async () => {
    mockContract.interface.parseLog.mockReturnValue({
      name: 'NewFeedback',
      args: {
        agentId: 0x123n,
        clientAddress: signerAddress,
        feedbackIndex: 7n,
      },
    });

    const result = await sender.sendFeedback('0x123', 5, 0, 'tag1', 'tag2', 'endpoint', 'uri', '0x1234');

    expect(result).toEqual({
      success: true,
      txHash: '0xreceipt',
      agentId: '0x123',
      feedbackIndex: 7,
    });
    expect(mockContract.giveFeedback.estimateGas).toHaveBeenCalled();
    expect(mockContract.giveFeedback).toHaveBeenCalledWith(
      '0x123',
      5n,
      0,
      'tag1',
      'tag2',
      'endpoint',
      'uri',
      '0x0000000000000000000000000000000000000000000000000000000000001234',
      { gasLimit: 25200n }
    );
  });

  it('returns dry-run success without sending a transaction', async () => {
    mockConfig.DRY_RUN = true;

    const result = await sender.sendFeedback('0x123');

    expect(result.success).toBe(true);
    expect(result.txHash).toBe('0xDRYRUN');
    expect(mockContract.giveFeedback).not.toHaveBeenCalled();
  });

  it('finds matching active on-chain feedback entries', async () => {
    mockContract.getLastIndex.mockResolvedValue(3n);
    mockContract.readFeedback
      .mockResolvedValueOnce([100n, 0n, 'pgtcr_active', 'sepolia_testnet', false])
      .mockResolvedValueOnce([50n, 0n, 'other', '', false])
      .mockResolvedValueOnce([100n, 0n, 'pgtcr_active', 'sepolia_testnet', true]);

    const result = await sender.findMatchingActiveFeedbackIndices('0x123', {
      value: 100,
      decimals: 0,
      tag1: 'pgtcr_active',
      tag2: 'sepolia_testnet',
    });

    expect(result).toEqual([1]);
  });

  it('revokes feedback and waits for confirmation', async () => {
    const result = await sender.revokeFeedback('0x123', 2);

    expect(result).toEqual({
      success: true,
      txHash: '0xrevokereceipt',
      agentId: '0x123',
      feedbackIndex: 2,
    });
    expect(mockContract.revokeFeedback).toHaveBeenCalledWith('0x123', 2, { gasLimit: 21600n });
  });

  it('rejects invalid agent ids before sending', async () => {
    const result = await sender.sendFeedback('not-a-number');

    expect(result.success).toBe(false);
    expect(result.error?.message).toContain('Invalid agentId');
  });
});
