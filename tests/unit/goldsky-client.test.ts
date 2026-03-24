import { jest } from '@jest/globals';

// Expose mock config object for mutation in tests
let mockConfigObject: any;

jest.mock('../../src/config', () => {
  mockConfigObject = {
    GOLDSKY_ENDPOINT: 'https://api.goldsky.com/graphql',
    GOLDSKY_PAGE_SIZE: 100,
    GOLDSKY_TIMEOUT_MS: 30000,
    PGTCR_REGISTRY_ADDRESS: '0x1234567890123456789012345678901234567890',
    NODE_ENV: 'test',
    LOG_LEVEL: 'info',
    MIN_ACTIVE_DAYS: 3,
    MIN_AGE_SECONDS: 3 * 24 * 60 * 60, // 3 days in seconds
    CHAIN_ID: 11155111, // Sepolia default
  };
  return {
    getConfig: jest.fn().mockReturnValue(mockConfigObject),
    resetConfig: jest.fn(),
  };
});

jest.mock('../../src/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
}));

import logger from '../../src/logger';
import { GoldskyClient } from '../../src/goldsky-client';
import { getConfig } from '../../src/config';

// Capture original config values for restoration
const ORIGINAL_PGTCR_ADDRESS = mockConfigObject.PGTCR_REGISTRY_ADDRESS;

// Ensure module-level config is reset between tests
beforeEach(() => {
  // Reset mockConfigObject to default
  mockConfigObject.GOLDSKY_ENDPOINT = 'https://api.goldsky.com/graphql';
  mockConfigObject.GOLDSKY_PAGE_SIZE = 100;
  mockConfigObject.PGTCR_REGISTRY_ADDRESS = ORIGINAL_PGTCR_ADDRESS;
  mockConfigObject.NODE_ENV = 'test';
  mockConfigObject.LOG_LEVEL = 'info';
});

afterEach(() => {
  // Specifically restore PGTCR_REGISTRY_ADDRESS in case tests modified it
  mockConfigObject.PGTCR_REGISTRY_ADDRESS = ORIGINAL_PGTCR_ADDRESS;
});

describe('GoldskyClient', () => {
  let client: GoldskyClient;

  beforeEach(() => {
    jest.clearAllMocks();
    (getConfig as jest.Mock).mockReturnValue({
      GOLDSKY_ENDPOINT: 'https://api.goldsky.com/graphql',
      GOLDSKY_PAGE_SIZE: 100,
      GOLDSKY_TIMEOUT_MS: 30000,
      PGTCR_REGISTRY_ADDRESS: '0x1234567890123456789012345678901234567890',
      MIN_AGE_SECONDS: 3 * 24 * 60 * 60,
      CHAIN_ID: 11155111,
    });
    client = new GoldskyClient();
  });

  describe('fetchActiveCollateralizations', () => {
    it('should call paginateFetch with proper filters and order', async () => {
      const mockPaginate = jest.spyOn(client as any, 'paginateFetch').mockResolvedValue([]);

      await client.fetchActiveCollateralizations();

      expect(mockPaginate).toHaveBeenCalledWith(
        expect.objectContaining({
          status_in: ['Submitted', 'Reincluded'],
          stake_gt: '0',
          registryAddress: '0x1234567890123456789012345678901234567890',
          includedAt_lt: expect.any(String),
        }),
        'includedAt',
        'desc'
      );
    });

    it('should return result of paginateFetch', async () => {
      const mockEvents = [
        {
          id: '1',
          agent: '0x00000000000000000000000000000000000000000000000000000000000477',
          amount: 100n,
          status: 'registered',
          timestamp: 1,
          pgtcrId: 1,
        },
      ];
      jest.spyOn(client as any, 'paginateFetch').mockResolvedValue(mockEvents);

      const result = await client.fetchActiveCollateralizations();

      expect(result).toEqual(mockEvents);
    });
  });

  describe('fetchCollateralizationsSince', () => {
    it('should call paginateFetch with since timestamp and ascending order', async () => {
      const mockPaginate = jest.spyOn(client as any, 'paginateFetch').mockResolvedValue([]);
      const timestamp = 1700000000;

      await client.fetchCollateralizationsSince(timestamp);

      expect(mockPaginate).toHaveBeenCalledWith(
        expect.objectContaining({
          status_in: ['Submitted', 'Reincluded'],
          stake_gt: '0',
          includedAt_gte: timestamp,
          registryAddress: '0x1234567890123456789012345678901234567890',
        }),
        'includedAt',
        'asc'
      );
    });
  });



  describe('healthCheck', () => {
    it('should call executeQuery and return true on success', async () => {
      const mockExecute = jest.spyOn(client as any, 'executeQuery').mockResolvedValue({ items: [] });

      const result = await client.healthCheck();

      expect(mockExecute).toHaveBeenCalledWith(
        expect.objectContaining({ status_in: ['Submitted', 'Reincluded'], stake_gt: '0' }),
        'includedAt',
        'desc',
        0
      );
      expect(result).toBe(true);
    });

    it('should return false on error', async () => {
      jest.spyOn(client as any, 'executeQuery').mockRejectedValue(new Error('fail'));

      const result = await client.healthCheck();

      expect(result).toBe(false);
    });
  });

  // New comprehensive tests to cover previously untested code paths
  describe('Real implementation tests', () => {
    let client: GoldskyClient;
    let mockRequest: any;

    beforeEach(() => {
      // Use a small page size for pagination tests
      client = new GoldskyClient('https://test', 2);
      mockRequest = jest.fn();
      (client as any).client = { request: mockRequest };
    });

    describe('pagination', () => {
      it('should paginate through multiple pages and respect delay', async () => {
        jest.useFakeTimers();
        try {
          const items = [
            {
              id: '1',
              itemID: 'i1',
              submitter: '0xa1',
              stake: '100',
              includedAt: '1700000000',
              status: 'Submitted',
              metadata: { key0: '1', key2: 'eip155:11155111:0xaddress1' },
            },
            {
              id: '2',
              itemID: 'i2',
              submitter: '0xa2',
              stake: '200',
              includedAt: '1700000001',
              status: 'Submitted',
              metadata: { key0: '2', key2: 'eip155:11155111:0xaddress2' },
            },
            {
              id: '3',
              itemID: 'i3',
              submitter: '0xa3',
              stake: '300',
              includedAt: '1700000002',
              status: 'Submitted',
              metadata: { key0: '3', key2: 'eip155:11155111:0xaddress3' },
            },
          ];

          mockRequest
            .mockResolvedValueOnce({ items: items.slice(0, 2) } as any)
            .mockResolvedValueOnce({ items: [items[2]] } as any);

          const promise = client.fetchActiveCollateralizations();

          // Allow first request to resolve and schedule timer
          await Promise.resolve();
          await jest.runAllTimersAsync();

          const result = await promise;

          expect(mockRequest).toHaveBeenCalledTimes(2);
          expect(result).toHaveLength(3);
          expect(result.map(e => e.id)).toEqual(['1', '2', '3']);
        } finally {
          jest.useRealTimers();
        }
      });

      it('should not delay when there is no next page', async () => {
        jest.useFakeTimers();
        try {
          mockRequest.mockResolvedValueOnce({ items: [] } as any);

          const promise = client.fetchActiveCollateralizations();
          await Promise.resolve();
          await jest.runAllTimersAsync();

          await promise;
          expect(mockRequest).toHaveBeenCalledTimes(1);
          // No timer should have been scheduled after the first page
        } finally {
          jest.useRealTimers();
        }
      });
    });

    describe('transformEvents', () => {
      const chainId = 11155111; // default CHAIN_ID for tests

      beforeEach(() => {
        mockConfigObject.CHAIN_ID = chainId;
      });

      it('should extract agentId from key0, apply chain filter, and map to bytes32', async () => {
        const nodes = [
          {
            id: 'item1',
            itemID: 'i1',
            submitter: '0xsubmitter',
            stake: '100',
            includedAt: '1700000000',
            status: 'Submitted',
            metadata: {
              key0: '1143',
              key2: `eip155:${chainId}:0xaddress`,
            },
          },
        ];

        const result = await (client as any).transformEvents(nodes);

        expect(result).toHaveLength(1);
        // 1143 in hex is 0x477, padded to 64 hex digits => 0x000...477 (61 zeros)
        const expectedAgent1143 = '0x' + '0'.repeat(61) + '477';
        expect(result[0].id).toBe('item1');
        expect(result[0].agent).toBe(expectedAgent1143);
        expect(result[0].amount).toBe(100n);
        expect(result[0].timestamp).toBe(1700000000);
        expect(result[0].status).toBe('registered');
        expect(result[0].pgtcrId).toBe(1);
      });

      it('should skip items with wrong chainId', async () => {
        const nodes = [
          {
            id: 'item-wrong-chain',
            itemID: 'i1',
            submitter: '0xsubmitter',
            stake: '100',
            includedAt: '1700000000',
            status: 'Submitted',
            metadata: {
              key0: '123',
              key2: 'eip155:1:0xaddress', // mainnet chain ID 1
            },
          },
        ];

        const result = await (client as any).transformEvents(nodes);
        expect(result).toHaveLength(0);
      });

      it('should skip items missing key0', async () => {
        const nodes = [
          {
            id: 'item-missing-key0',
            itemID: 'i1',
            submitter: '0xsubmitter',
            stake: '100',
            includedAt: '1700000000',
            status: 'Submitted',
            metadata: {
              key2: `eip155:${chainId}:0xaddress`,
            },
          },
        ];

        const result = await (client as any).transformEvents(nodes);
        expect(result).toHaveLength(0);
      });

      it('should skip items with non-numeric key0', async () => {
        const nodes = [
          {
            id: 'item-nonnumeric',
            itemID: 'i1',
            submitter: '0xsubmitter',
            stake: '100',
            includedAt: '1700000000',
            status: 'Submitted',
            metadata: {
              key0: 'abc123',
              key2: `eip155:${chainId}:0xaddress`,
            },
          },
        ];

        const result = await (client as any).transformEvents(nodes);
        expect(result).toHaveLength(0);
      });

      it('should skip items with invalid key2 format', async () => {
        const nodes = [
          {
            id: 'item-invalid-key2',
            itemID: 'i1',
            submitter: '0xsubmitter',
            stake: '100',
            includedAt: '1700000000',
            status: 'Submitted',
            metadata: {
              key0: '123',
              key2: 'invalid_format',
            },
          },
        ];

        const result = await (client as any).transformEvents(nodes);
        expect(result).toHaveLength(0);
      });

      it('should skip items missing key2', async () => {
        const nodes = [
          {
            id: 'item-missing-key2',
            itemID: 'i1',
            submitter: '0xsubmitter',
            stake: '100',
            includedAt: '1700000000',
            status: 'Submitted',
            metadata: {
              key0: '123',
            },
          },
        ];

        const result = await (client as any).transformEvents(nodes);
        expect(result).toHaveLength(0);
      });

      it('should process multiple valid items', async () => {
        const nodes = [
          {
            id: 'item1',
            itemID: 'i1',
            submitter: '0xsubmitter1',
            stake: '100',
            includedAt: '1700000000',
            status: 'Submitted',
            metadata: {
              key0: '100',
              key2: `eip155:${chainId}:0xaddress1`,
            },
          },
          {
            id: 'item2',
            itemID: 'i2',
            submitter: '0xsubmitter2',
            stake: '200',
            includedAt: '1700003600',
            status: 'Submitted',
            metadata: {
              key0: '200',
              key2: `eip155:${chainId}:0xaddress2`,
            },
          },
        ];

        const result = await (client as any).transformEvents(nodes);
        expect(result).toHaveLength(2);
        // Compute expected bytes32 padded
        const agent100 = '0x' + '0'.repeat(62) + '64';
        const agent200 = '0x' + '0'.repeat(62) + 'c8';
        expect(result[0].agent).toBe(agent100);
        expect(result[1].agent).toBe(agent200);
      });

      it('should enforce strict key0: reject when key0 missing', async () => {
        const nodes = [
          {
            id: 'item-rejected',
            itemID: 'i1',
            submitter: '0xsubmitter',
            stake: '100',
            includedAt: '1700000000',
            status: 'Submitted',
            metadata: {
              key2: `eip155:${chainId}:0xaddress`,
            },
          },
        ];

        const result = await (client as any).transformEvents(nodes);

        // Strict key0 enforcement: must have key0
        expect(result).toHaveLength(0);
        expect(logger.warn).toHaveBeenCalledWith(
          'Skipping item: metadata.key0 is missing, empty, or not a valid integer string',
          expect.objectContaining({ itemId: 'item-rejected', key0: undefined })
        );
      });

      it('should reject item with non-numeric key0 (strict validation)', async () => {
        const nodes = [
          {
            id: 'item-nonnumeric-key0',
            itemID: 'i1',
            submitter: '0xsubmitter',
            stake: '100',
            includedAt: '1700000000',
            status: 'Submitted',
            metadata: {
              key0: 'abc',
              key2: `eip155:${chainId}:0xaddress`,
            },
          },
        ];

        const result = await (client as any).transformEvents(nodes);

        // Must have numeric key0
        expect(result).toHaveLength(0);
        expect(logger.warn).toHaveBeenCalledWith(
          'Skipping item: metadata.key0 is missing, empty, or not a valid integer string',
          expect.objectContaining({ itemId: 'item-nonnumeric-key0', key0: 'abc' })
        );
      });
    });

    describe('error handling', () => {
      it('should propagate and log errors from request', async () => {
        jest.useFakeTimers();
        try {
          const error = new Error('GraphQL failure');
          // Reject all attempts to simulate persistent failure
          mockRequest.mockRejectedValue(error as any);

          const promise = client.fetchActiveCollateralizations();

          // Attach rejection handler immediately to avoid unhandled rejection
          const rejectionPromise = promise.catch(e => e);

          // Fast-forward through all retry delays
          await jest.runAllTimersAsync();

          // Now the promise should be rejected
          const caught = await rejectionPromise;
          expect(caught).toBe(error);

          // Verify logger.error called with a message containing "failed after" and error details
          expect(logger.error).toHaveBeenCalledWith(
            expect.stringMatching(/failed after \d+ attempts/),
            expect.objectContaining({ error: error.message })
          );
        } finally {
          jest.useRealTimers();
        }
      });
    });

    describe('fetchActiveCollateralizations without registry address', () => {
      it('should log warning and omit registryAddress from query variables', async () => {
        (getConfig as jest.Mock).mockReturnValue({
          ...mockConfigObject,
          PGTCR_REGISTRY_ADDRESS: undefined,
        });

        const freshClient = new GoldskyClient();
        (freshClient as any).client = { request: mockRequest };
        mockRequest.mockResolvedValue({ items: [] } as any);

        await freshClient.fetchActiveCollateralizations();

        expect(logger.warn).toHaveBeenCalledWith('PGTCR_REGISTRY_ADDRESS not configured; fetching items from all registries');

        const variables = mockRequest.mock.calls[0][1] as any;
        expect(variables.where).not.toHaveProperty('registryAddress');
        // The where should contain only status_in, stake_gt, includedAt_lt
        expect(Object.keys(variables.where).sort()).toEqual(['includedAt_lt', 'stake_gt', 'status_in']);
      });
    });

    describe('executeQuery and healthCheck integration', () => {
      it('healthCheck should return true on successful executeQuery', async () => {
        mockRequest.mockResolvedValue({ items: [] } as any);
        const result = await client.healthCheck();
        expect(result).toBe(true);
        expect(mockRequest).toHaveBeenCalledTimes(1);
        const vars = mockRequest.mock.calls[0][1] as any;
        expect(vars.where).toEqual({ status_in: ['Submitted', 'Reincluded'], stake_gt: '0' });
        expect(vars.orderBy).toBe('includedAt');
        expect(vars.orderDirection).toBe('desc');
        expect(vars.skip).toBe(0);
        expect(vars.first).toBe((client as any).pageSize);
      });

      it('healthCheck should return false on executeQuery failure', async () => {
        jest.useFakeTimers();
        try {
          mockRequest.mockRejectedValue(new Error('fail') as any);
          const promise = client.healthCheck();
          await jest.runAllTimersAsync();
          const result = await promise;
          expect(result).toBe(false);
        } finally {
          jest.useRealTimers();
        }
      });
    });
  });
});
