import { jest } from '@jest/globals';

// Mock config
jest.mock('../../src/config', () => {
  const mockConfig = {
    CHAIN_ID: 11155111, // Sepolia
  };
  return {
    getConfig: jest.fn().mockReturnValue(mockConfig),
    resetConfig: jest.fn(),
  };
});

// Mock logger
jest.mock('../../src/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
}));

import logger from '../../src/logger';
import { GoldskyItemsMapper, createGoldskyMapper, type GoldskyItem } from '../../src/goldsky-items-mapper';
import { getConfig } from '../../src/config';
import { ethers } from 'ethers';

describe('GoldskyItemsMapper', () => {
  let mapper: GoldskyItemsMapper;

  beforeEach(() => {
    jest.clearAllMocks();
    (getConfig as jest.Mock).mockReturnValue({ CHAIN_ID: 11155111 });
    mapper = new GoldskyItemsMapper({ logWarnings: true });
  });

  describe('mapItem - valid conversions', () => {
    it('should map a valid item with numeric key0 and Sepolia chain', async () => {
      const item: GoldskyItem = {
        id: 'item-123',
        itemID: 'i123',
        submitter: '0xsubmitter',
        stake: '100',
        includedAt: '1700000000',
        status: 'Submitted',
        metadata: {
          key0: '1143',
          key2: 'eip155:11155111:0xaddress',
          props: [],
        },
      };

      const result = await mapper.mapItem(item);

      expect(result).not.toBeNull();
      // 1143 in hex is 0x477, padded to 64 hex chars => 0x000...477 (61 zeros)
      const expectedAgentId = '0x' + '0'.repeat(61) + '477';
      expect(result!.agent).toBe(expectedAgentId);
      expect(result!.amount).toBe(BigInt(100));
      expect(result!.timestamp).toBe(1700000000);
      expect(result!.status).toBe('registered');
      expect(result!.pgtcrId).toBe(1);
    });

    it('should use custom pgtcrId when provided', async () => {
      const customMapper = new GoldskyItemsMapper({ pgtcrId: 42 });
      const item: GoldskyItem = {
        id: 'item-pgtcr',
        itemID: 'ipgtcr',
        submitter: '0xsubmitter',
        stake: '100',
        includedAt: '1700000000',
        status: 'Submitted',
        metadata: {
          key0: '5',
          key2: 'eip155:11155111:0xaddress',
          props: [],
        },
      };

      const result = await customMapper.mapItem(item);
      expect(result).not.toBeNull();
      expect(result!.pgtcrId).toBe(42);
    });

    it('should throw on invalid pgtcrId (non-positive) in constructor', () => {
      expect(() => new GoldskyItemsMapper({ pgtcrId: 0 })).toThrow('pgtcrId must be a positive integer');
      expect(() => new GoldskyItemsMapper({ pgtcrId: -1 })).toThrow('pgtcrId must be a positive integer');
      expect(() => new GoldskyItemsMapper({ pgtcrId: 3.5 })).toThrow('pgtcrId must be a positive integer');
      expect(() => new GoldskyItemsMapper({ pgtcrId: NaN })).toThrow('pgtcrId must be a positive integer');
    });

    it('should handle large numeric key0 values (up to bytes32 max)', async () => {
      const item: GoldskyItem = {
        id: 'item-large',
        itemID: 'i9999999999999999999999999999999',
        submitter: '0xsubmitter',
        stake: '0',
        includedAt: '1700000000',
        status: 'Submitted',
        metadata: {
          key0: '9999999999999999999999999999999',
          key2: 'eip155:11155111:0xaddress',
          props: [],
        },
      };

      const result = await mapper.mapItem(item);

      expect(result).not.toBeNull();
      // The large number should be converted to BigInt and then to hex
      const expectedHex = BigInt(item.metadata.key0!).toString(16);
      const expectedAgentId = '0x' + expectedHex.padStart(64, '0');
      expect(result!.agent).toBe(expectedAgentId);
    });

    it('should map zero key0 correctly', async () => {
      const item: GoldskyItem = {
        id: 'item-zero',
        itemID: 'i0',
        submitter: '0xsubmitter',
        stake: '1',
        includedAt: '1700000000',
        status: ' Submitted',
        metadata: {
          key0: '0',
          key2: 'eip155:11155111:0xaddress',
          props: [],
        },
      };

      const result = await mapper.mapItem(item);

      expect(result).not.toBeNull();
      expect(result!.agent).toBe('0x' + '0'.repeat(64)); // all zeros
    });

    it('should map multiple valid items efficiently', async () => {
      const items: GoldskyItem[] = [
        {
          id: 'item1',
          itemID: 'i1',
          submitter: '0xs1',
          stake: '100',
          includedAt: '1700000000',
          status: 'Submitted',
          metadata: { key0: '1', key2: 'eip155:11155111:0xa1', props: [] },
        },
        {
          id: 'item2',
          itemID: 'i2',
          submitter: '0xs2',
          stake: '200',
          includedAt: '1700003600',
          status: 'Submitted',
          metadata: { key0: '2', key2: 'eip155:11155111:0xa2', props: [] },
        },
        {
          id: 'item3',
          itemID: 'i3',
          submitter: '0xs3',
          stake: '300',
          includedAt: '1700007200',
          status: 'Submitted',
          metadata: { key0: '300', key2: 'eip155:11155111:0xa3', props: [] },
        },
      ];

      const results = await mapper.mapItems(items);

      expect(results).toHaveLength(3);
      expect(results[0].agent).toBe('0x' + '0'.repeat(63) + '1');
      expect(results[1].agent).toBe('0x' + '0'.repeat(63) + '2');
      expect(results[2].agent).toBe('0x' + '0'.repeat(61) + '12c'); // 300 decimal = 0x12c
    });
  });

  describe('mapItem - chain filtering', () => {
    const baseItem = (chainId: number): GoldskyItem => ({
      id: `item-${chainId}`,
      itemID: `i${chainId}`,
      submitter: '0xsubmitter',
      stake: '100',
      includedAt: '1700000000',
      status: 'Submitted',
      metadata: {
        key0: '123',
        key2: `eip155:${chainId}:0xaddress`,
        props: [],
      },
    });

    it('should skip items with non-Sepolia chain ID (e.g., mainnet 1)', async () => {
      const item = baseItem(1);
      const result = await mapper.mapItem(item);
      expect(result).toBeNull();
      expect(logger.warn).toHaveBeenCalledWith('Skipping item: chain ID does not match target Sepolia', expect.objectContaining({ itemId: item.id, chainId: 1, expectedChainId: 11155111 }));
    });

    it('should skip items with chain ID 5 (Goerli)', async () => {
      const item = baseItem(5);
      const result = await mapper.mapItem(item);
      expect(result).toBeNull();
    });

    it('should accept Sepolia chain ID (11155111)', async () => {
      const item = baseItem(11155111);
      const result = await mapper.mapItem(item);
      expect(result).not.toBeNull();
      expect(result!.agent).toBe('0x' + '0'.repeat(62) + '7b'); // 123 = 0x7b
    });

    it('should accept custom chain ID when configured', async () => {
      const customMapper = new GoldskyItemsMapper({ chainId: 1 });
      const item = baseItem(1);
      const result = await customMapper.mapItem(item);
      expect(result).not.toBeNull();
    });
  });

  describe('mapItem - strict key0 enforcement (no fallback to props)', () => {
    it('should ignore props.isIdentifier even with valid numeric value (strict key0 only)', async () => {
      const item: GoldskyItem = {
        id: 'item-props-ignored',
        itemID: 'iprops',
        submitter: '0xsubmitter',
        stake: '100',
        includedAt: '1700000000',
        status: 'Submitted',
        metadata: {
          key0: '456',
          key2: 'eip155:11155111:0xaddress',
          props: [
            { isIdentifier: true, type: 'string', label: 'agentId', value: '999' },
          ],
        },
      };

      const result = await mapper.mapItem(item);
      expect(result).not.toBeNull();
      // Should use key0 (456), not the prop value (999)
      const expectedAgentId = '0x' + '0'.repeat(61) + '1c8'; // 456 in hex = 0x1c8
      expect(result!.agent).toBe(expectedAgentId);
    });

    it('should reject item when key0 is missing even if props.isIdentifier has valid numeric value', async () => {
      const item: GoldskyItem = {
        id: 'item-rejected',
        itemID: 'ireject',
        submitter: '0xsubmitter',
        stake: '100',
        includedAt: '1700000000',
        status: 'Submitted',
        metadata: {
          key2: 'eip155:11155111:0xaddress',
          props: [
            { isIdentifier: true, type: 'string', label: 'agentId', value: '789' },
          ],
        },
      };

      const result = await mapper.mapItem(item);
      expect(result).toBeNull();
      expect(logger.warn).toHaveBeenCalledWith(
        'Skipping item: metadata.key0 is missing, empty, or not a valid integer string',
        expect.objectContaining({ itemId: 'item-rejected', key0: undefined })
      );
    });
  });

  describe('mapItem - missing/invalid key0 (REQUIRED)', () => {
    const baseItem = (key0?: string): GoldskyItem => ({
      id: 'item-test',
      itemID: 'itest',
      submitter: '0xsubmitter',
      stake: '100',
      includedAt: '1700000000',
      status: 'Submitted',
      metadata: {
        key0,
        key2: 'eip155:11155111:0xaddress',
        props: [],
      },
    });

    it('should skip when key0 is undefined', async () => {
      const result = await mapper.mapItem(baseItem(undefined));
      expect(result).toBeNull();
      expect(logger.warn).toHaveBeenCalledWith('Skipping item: metadata.key0 is missing, empty, or not a valid integer string', {
        itemId: 'item-test',
        key0: undefined,
      });
    });

    it('should skip when key0 is null', async () => {
      const result = await mapper.mapItem(baseItem(null as any));
      expect(result).toBeNull();
      expect(logger.warn).toHaveBeenCalledWith('Skipping item: metadata.key0 is missing, empty, or not a valid integer string', {
        itemId: 'item-test',
        key0: null,
      });
    });

    it('should skip when key0 is empty string', async () => {
      const result = await mapper.mapItem(baseItem(''));
      expect(result).toBeNull();
      expect(logger.warn).toHaveBeenCalledWith('Skipping item: metadata.key0 is missing, empty, or not a valid integer string', {
        itemId: 'item-test',
        key0: '',
      });
    });

    it('should skip when key0 is whitespace only (trims to empty)', async () => {
      const result = await mapper.mapItem(baseItem('   '));
      expect(result).toBeNull();
      expect(logger.warn).toHaveBeenCalledWith('Skipping item: metadata.key0 is missing, empty, or not a valid integer string', {
        itemId: 'item-test',
        key0: '   ',
      });
    });

    it('should skip when key0 is non-numeric string', async () => {
      const result = await mapper.mapItem(baseItem('abc123'));
      expect(result).toBeNull();
      expect(logger.warn).toHaveBeenCalledWith('Skipping item: metadata.key0 is missing, empty, or not a valid integer string', {
        itemId: 'item-test',
        key0: 'abc123',
      });
    });

    it('should skip when key0 contains decimal point', async () => {
      const result = await mapper.mapItem(baseItem('123.45'));
      expect(result).toBeNull();
      expect(logger.warn).toHaveBeenCalledWith('Skipping item: metadata.key0 is missing, empty, or not a valid integer string', {
        itemId: 'item-test',
        key0: '123.45',
      });
    });

    it('should skip when key0 contains hexadecimal prefix', async () => {
      const result = await mapper.mapItem(baseItem('0x123'));
      expect(result).toBeNull();
      expect(logger.warn).toHaveBeenCalledWith('Skipping item: metadata.key0 is missing, empty, or not a valid integer string', {
        itemId: 'item-test',
        key0: '0x123',
      });
    });

    it('should skip when key0 is negative number string', async () => {
      const result = await mapper.mapItem(baseItem('-42'));
      expect(result).toBeNull();
      expect(logger.warn).toHaveBeenCalledWith(
        'Skipping item: metadata.key0 is missing, empty, or not a valid integer string',
        expect.objectContaining({ key0: '-42' })
      );
    });
  });

  describe('mapItem - malformed CAIP10 (REQUIRED)', () => {
    const baseItem = (key2: string | undefined): GoldskyItem => ({
      id: 'item-test',
      itemID: 'itest',
      submitter: '0xsubmitter',
      stake: '100',
      includedAt: '1700000000',
      status: 'Submitted',
      metadata: {
        key0: '123',
        key2,
        props: [],
      },
    });

    it('should skip when key2 is missing (undefined)', async () => {
      const result = await mapper.mapItem(baseItem(undefined));
      expect(result).toBeNull();
      expect(logger.warn).toHaveBeenCalledWith('Skipping item: metadata.key2 (CAIP10) is missing', { itemId: 'item-test' });
    });

    it('should skip when key2 is null', async () => {
      const result = await mapper.mapItem(baseItem(null as any));
      expect(result).toBeNull();
      // null is treated as missing (set to '' then empty)
      expect(logger.warn).toHaveBeenCalledWith('Skipping item: metadata.key2 (CAIP10) is missing', { itemId: 'item-test' });
    });

    it('should skip when key2 is empty string', async () => {
      const result = await mapper.mapItem(baseItem(''));
      expect(result).toBeNull();
      expect(logger.warn).toHaveBeenCalledWith('Skipping item: metadata.key2 (CAIP10) is missing', { itemId: 'item-test' });
    });

    it('should skip when key2 has invalid format (no colon)', async () => {
      const result = await mapper.mapItem(baseItem('eip15512345'));
      expect(result).toBeNull();
      expect(logger.warn).toHaveBeenCalledWith('Skipping item: metadata.key2 is not a valid CAIP10 format', {
        itemId: 'item-test',
        key2: 'eip15512345',
      });
    });

    it('should skip when key2 has missing chain ID (only prefix and colon)', async () => {
      const result = await mapper.mapItem(baseItem('eip155:'));
      expect(result).toBeNull();
      expect(logger.warn).toHaveBeenCalledWith('Skipping item: metadata.key2 is not a valid CAIP10 format', {
        itemId: 'item-test',
        key2: 'eip155:',
      });
    });

    it('should skip when key2 has non-numeric chain ID', async () => {
      const result = await mapper.mapItem(baseItem('eip155:abc:0xaddress'));
      expect(result).toBeNull();
      expect(logger.warn).toHaveBeenCalledWith('Skipping item: metadata.key2 is not a valid CAIP10 format', {
        itemId: 'item-test',
        key2: 'eip155:abc:0xaddress',
      });
    });

    it('should skip when key2 has non-numeric chain ID with spaces', async () => {
      const result = await mapper.mapItem(baseItem('eip155: abc :0xaddress'));
      expect(result).toBeNull();
      expect(logger.warn).toHaveBeenCalledWith('Skipping item: metadata.key2 is not a valid CAIP10 format', {
        itemId: 'item-test',
        key2: 'eip155: abc :0xaddress',
      });
    });

    it('should skip when key2 has wrong prefix (not eip155)', async () => {
      const result = await mapper.mapItem(baseItem('solana:123:address'));
      expect(result).toBeNull();
      expect(logger.warn).toHaveBeenCalledWith('Skipping item: metadata.key2 is not a valid CAIP10 format', {
        itemId: 'item-test',
        key2: 'solana:123:address',
      });
    });
  });

  describe('mapItem - chain mismatch (REQUIRED)', () => {
    const baseItem = (chainId: number): GoldskyItem => ({
      id: `item-${chainId}`,
      itemID: `i${chainId}`,
      submitter: '0xsubmitter',
      stake: '100',
      includedAt: '1700000000',
      status: 'Submitted',
      metadata: {
        key0: '123',
        key2: `eip155:${chainId}:0xaddress`,
        props: [],
      },
    });

    it('should skip items with chain ID 1 (mainnet) when target is Sepolia', async () => {
      const item = baseItem(1);
      const result = await mapper.mapItem(item);
      expect(result).toBeNull();
      expect(logger.warn).toHaveBeenCalledWith(
        'Skipping item: chain ID does not match target Sepolia',
        expect.objectContaining({ itemId: item.id, chainId: 1, expectedChainId: 11155111 })
      );
    });

    it('should skip items with chain ID 5 (Goerli) when target is Sepolia', async () => {
      const item = baseItem(5);
      const result = await mapper.mapItem(item);
      expect(result).toBeNull();
    });

    it('should skip items with chain ID 137 (Polygon) when target is Sepolia', async () => {
      const item = baseItem(137);
      const result = await mapper.mapItem(item);
      expect(result).toBeNull();
    });

    it('should accept Sepolia chain ID (11155111) when target is Sepolia', async () => {
      const item = baseItem(11155111);
      const result = await mapper.mapItem(item);
      expect(result).not.toBeNull();
      expect(result!.agent).toBe('0x' + '0'.repeat(62) + '7b'); // 123 = 0x7b
    });

    it('should accept custom chain ID when configured', async () => {
      const customMapper = new GoldskyItemsMapper({ chainId: 1 });
      const item = baseItem(1);
      const result = await customMapper.mapItem(item);
      expect(result).not.toBeNull();
    });
  });

  describe('mapItem - overflow handling (REQUIRED)', () => {
    it('should reject agentId that exceeds bytes32 max', async () => {
      // 2^256 equals max+1, so this is overflow
      const maxPlusOne = (2n ** 256n).toString();
      const item: GoldskyItem = {
        id: 'item-overflow',
        itemID: 'iof',
        submitter: '0xsubmitter',
        stake: '100',
        includedAt: '1700000000',
        status: 'Submitted',
        metadata: {
          key0: maxPlusOne,
          key2: 'eip155:11155111:0xaddress',
          props: [],
        },
      };

      const result = await mapper.mapItem(item);
      expect(result).toBeNull();
      expect(logger.warn).toHaveBeenCalledWith(
        'Skipping item: failed to convert agentId to bytes32',
        expect.objectContaining({ itemId: 'item-overflow', agentIdStr: maxPlusOne })
      );
    });

    it('should accept exactly max bytes32 value', async () => {
      const maxBytes32 = (2n ** 256n) - 1n;
      const item: GoldskyItem = {
        id: 'item-max',
        itemID: 'imax',
        submitter: '0xsubmitter',
        stake: '0',
        includedAt: '1700000000',
        status: 'Submitted',
        metadata: {
          key0: maxBytes32.toString(),
          key2: 'eip155:11155111:0xaddress',
          props: [],
        },
      };

      const result = await mapper.mapItem(item);
      expect(result).not.toBeNull();
      const expectedHex = '0x' + 'f'.repeat(64);
      expect(result!.agent).toBe(expectedHex);
    });

    it('should accept value just one less than max', async () => {
      const nearMax = (2n ** 256n) - 2n;
      const item: GoldskyItem = {
        id: 'item-near-max',
        itemID: 'inearmax',
        submitter: '0xsubmitter',
        stake: '0',
        includedAt: '1700000000',
        status: 'Submitted',
        metadata: {
          key0: nearMax.toString(),
          key2: 'eip155:11155111:0xaddress',
          props: [],
        },
      };

      const result = await mapper.mapItem(item);
      expect(result).not.toBeNull();
    });
  });

  describe('mapItem - whitespace handling (REQUIRED)', () => {
    it('should trim leading and trailing whitespace in key0', async () => {
      const item: GoldskyItem = {
        id: 'item-ws-key0',
        itemID: 'iwsk0',
        submitter: '0xsubmitter',
        stake: '100',
        includedAt: '1700000000',
        status: 'Submitted',
        metadata: {
          key0: '  456  ',
          key2: 'eip155:11155111:0xaddress',
          props: [],
        },
      };

      const result = await mapper.mapItem(item);
      expect(result).not.toBeNull();
      // 456 decimal = 0x1c8
      expect(result!.agent).toBe('0x' + '0'.repeat(61) + '1c8');
    });

    it('should trim leading and trailing whitespace in key2 (CAIP10)', async () => {
      const item: GoldskyItem = {
        id: 'item-ws-key2',
        itemID: 'iwsk2',
        submitter: '0xsubmitter',
        stake: '100',
        includedAt: '1700000000',
        status: 'Submitted',
        metadata: {
          key0: '123',
          key2: '  eip155:11155111:0xaddress  ',
          props: [],
        },
      };

      const result = await mapper.mapItem(item);
      expect(result).not.toBeNull();
    });

    it('should trim key0 that is all whitespace and treat as empty (reject)', async () => {
      const item: GoldskyItem = {
        id: 'item-ws-empty',
        itemID: 'iwempty',
        submitter: '0xsubmitter',
        stake: '100',
        includedAt: '1700000000',
        status: 'Submitted',
        metadata: {
          key0: '\t\n  ',
          key2: 'eip155:11155111:0xaddress',
          props: [],
        },
      };

      const result = await mapper.mapItem(item);
      expect(result).toBeNull();
      expect(logger.warn).toHaveBeenCalledWith(
        'Skipping item: metadata.key0 is missing, empty, or not a valid integer string',
        expect.objectContaining({ key0: '\t\n  ' })
      );
    });

    it('should trim key2 that is all whitespace and treat as missing', async () => {
      const item: GoldskyItem = {
        id: 'item-ws-key2-empty',
        itemID: 'iwk2empty',
        submitter: '0xsubmitter',
        stake: '100',
        includedAt: '1700000000',
        status: 'Submitted',
        metadata: {
          key0: '123',
          key2: '   ',
          props: [],
        },
      };

      const result = await mapper.mapItem(item);
      expect(result).toBeNull();
      expect(logger.warn).toHaveBeenCalledWith('Skipping item: metadata.key2 (CAIP10) is missing', { itemId: 'item-ws-key2-empty' });
    });
  });

  describe('mapItem - stake and timestamp parsing', () => {
    it('should parse valid numeric stake as BigInt', async () => {
      const item: GoldskyItem = {
        id: 'item-stake',
        itemID: 'istake',
        submitter: '0xsubmitter',
        stake: '123456',
        includedAt: '1700000000',
        status: 'Submitted',
        metadata: {
          key0: '999',
          key2: 'eip155:11155111:0xaddress',
          props: [],
        },
      };

      const result = await mapper.mapItem(item);
      expect(result).not.toBeNull();
      expect(result!.amount).toBe(BigInt(123456));
    });

    it('should parse valid timestamp as Number', async () => {
      const item: GoldskyItem = {
        id: 'item-time',
        itemID: 'itime',
        submitter: '0xsubmitter',
        stake: '100',
        includedAt: '1700000000',
        status: 'Submitted',
        metadata: {
          key0: '1',
          key2: 'eip155:11155111:0xaddress',
          props: [],
        },
      };

      const result = await mapper.mapItem(item);
      expect(result).not.toBeNull();
      expect(result!.timestamp).toBe(1700000000);
    });

    it('should skip when stake is not a valid integer', async () => {
      const item: GoldskyItem = {
        id: 'item-badstake',
        itemID: 'ibs',
        submitter: '0xsubmitter',
        stake: 'not-a-number',
        includedAt: '1700000000',
        status: 'Submitted',
        metadata: {
          key0: '123',
          key2: 'eip155:11155111:0xaddress',
          props: [],
        },
      };

      const result = await mapper.mapItem(item);
      expect(result).toBeNull();
      expect(logger.warn).toHaveBeenCalledWith('Skipping item: failed to parse stake or timestamp', {
        itemId: 'item-badstake',
        error: expect.any(Error),
      });
    });

    it('should skip when includedAt is not a valid number', async () => {
      const item: GoldskyItem = {
        id: 'item-badtime',
        itemID: 'ibt',
        submitter: '0xsubmitter',
        stake: '100',
        includedAt: 'not-a-timestamp',
        status: 'Submitted',
        metadata: {
          key0: '123',
          key2: 'eip155:11155111:0xaddress',
          props: [],
        },
      };

      const result = await mapper.mapItem(item);
      expect(result).toBeNull();
      expect(logger.warn).toHaveBeenCalledWith('Skipping item: failed to parse stake or timestamp', {
        itemId: 'item-badtime',
        error: expect.any(Error),
      });
    });

    it('should skip when includedAt is NaN', async () => {
      const item: GoldskyItem = {
        id: 'item-nan',
        itemID: 'inan',
        submitter: '0xsubmitter',
        stake: '100',
        includedAt: 'NaN',
        status: 'Submitted',
        metadata: {
          key0: '123',
          key2: 'eip155:11155111:0xaddress',
          props: [],
        },
      };

      const result = await mapper.mapItem(item);
      expect(result).toBeNull();
      expect(logger.warn).toHaveBeenCalledWith('Skipping item: failed to parse stake or timestamp', {
        itemId: 'item-nan',
        error: expect.any(Error),
      });
    });

    it('should skip when includedAt is negative', async () => {
      const item: GoldskyItem = {
        id: 'item-neg',
        itemID: 'ineg',
        submitter: '0xsubmitter',
        stake: '100',
        includedAt: '-100',
        status: 'Submitted',
        metadata: {
          key0: '123',
          key2: 'eip155:11155111:0xaddress',
          props: [],
        },
      };

      const result = await mapper.mapItem(item);
      expect(result).toBeNull();
    });
  });

  describe('mapItems - batch processing', () => {
    const createItem = (id: string, key0?: string, chainId: number = 11155111): GoldskyItem => ({
      id,
      itemID: `i${id}`,
      submitter: '0xsubmitter',
      stake: '100',
      includedAt: '1700000000',
      status: 'Submitted',
      metadata: {
        key0,
        key2: `eip155:${chainId}:0xaddress`,
        props: [],
      },
    });

    it('should filter out all invalid items and return only valid ones', async () => {
      const items: GoldskyItem[] = [
        createItem('valid1', '123'),
        createItem('missing-key0', undefined),
        createItem('non-numeric', 'abc'),
        createItem('wrong-chain', '456', 1), // mainnet
        createItem('valid2', '789'),
        createItem('invalid-key2', '101'), // will override key2
      ];
      // Fix the invalid key2 for the last item
      items[5].metadata.key2 = 'invalid';

      const results = await mapper.mapItems(items);

      expect(results).toHaveLength(2);
      expect(results.map(e => e.id)).toEqual(['valid1', 'valid2']);
    });

    it('should return empty array when all items are invalid', async () => {
      const items: GoldskyItem[] = [
        createItem('bad1', undefined),
        createItem('bad2', 'abc'),
        createItem('bad3', '123', 1),
      ];

      const results = await mapper.mapItems(items);

      expect(results).toEqual([]);
    });

    it('should handle large batches (1000 items) efficiently', async () => {
      const items: GoldskyItem[] = Array.from({ length: 1000 }, (_, i) =>
        createItem(`batch-${i}`, `${i}`)
      );

      const results = await mapper.mapItems(items);

      expect(results).toHaveLength(1000);
      expect(results[0].agent).toBe('0x' + '0'.repeat(64));
      expect(results[999].agent).toBe('0x' + BigInt(999).toString(16).padStart(64, '0'));
    });

    it('should not include any null results', async () => {
      const items: GoldskyItem[] = [
        createItem('valid', '1'),
        createItem('invalid', undefined),
      ];

      const results = await mapper.mapItems(items);

      expect(results).toHaveLength(1);
      expect(results[0].id).toBe('valid');
    });
  });

  describe('robustness checks - null metadata (REQUIRED)', () => {
    it('should skip item when metadata is null', async () => {
      const item: any = {
        id: 'item-null-meta',
        itemID: 'inull',
        submitter: '0xsubmitter',
        stake: '100',
        includedAt: '1700000000',
        status: 'Submitted',
        metadata: null,
      };

      const result = await mapper.mapItem(item);
      expect(result).toBeNull();
      expect(logger.warn).toHaveBeenCalledWith(
        'Skipping item: metadata is null or undefined',
        { itemId: 'item-null-meta' }
      );
    });

    it('should skip item when metadata is undefined', async () => {
      const item: any = {
        id: 'item-undefined-meta',
        itemID: 'iundef',
        submitter: '0xsubmitter',
        stake: '100',
        includedAt: '1700000000',
        status: 'Submitted',
      };

      const result = await mapper.mapItem(item);
      expect(result).toBeNull();
    });

    it('should skip item when metadata is an empty object', async () => {
      const item: GoldskyItem = {
        id: 'item-empty-meta',
        itemID: 'iempty',
        submitter: '0xsubmitter',
        stake: '100',
        includedAt: '1700000000',
        status: 'Submitted',
        metadata: {},
      };

      const result = await mapper.mapItem(item);
      expect(result).toBeNull();
      // It will fail on key2 missing
      expect(logger.warn).toHaveBeenCalledWith('Skipping item: metadata.key2 (CAIP10) is missing', { itemId: 'item-empty-meta' });
    });
  });

  describe('edge cases - extra metadata fields ignored', () => {
    it('should ignore metadata.key1, key3, key4, and other arbitrary fields', async () => {
      const item: GoldskyItem = {
        id: 'item-extra',
        itemID: 'iextra',
        submitter: '0xsubmitter',
        stake: '50',
        includedAt: '1700000000',
        status: 'Submitted',
        metadata: {
          key0: '42',
          key1: 'should be ignored',
          key2: 'eip155:11155111:0xaddress',
          key3: 'also ignored',
          key4: 'ignored too',
          someRandomField: 'value',
          props: [
            { isIdentifier: false, type: 'string', label: 'ignore', value: 'yes' },
          ],
        },
      };

      const result = await mapper.mapItem(item);
      expect(result).not.toBeNull();
      expect(result!.agent).toBe('0x' + '0'.repeat(62) + '2a'); // 42 = 0x2a
    });
  });

  describe('logger interactions', () => {
    it('should not log warnings when logWarnings is false', async () => {
      const silentMapper = new GoldskyItemsMapper({ logWarnings: false });
      const item: GoldskyItem = {
        id: 'item-bad',
        itemID: 'ibad',
        submitter: '0xsubmitter',
        stake: '100',
        includedAt: '1700000000',
        status: 'Submitted',
        metadata: {
          key0: 'abc',
          key2: 'eip155:11155111:0xaddress',
          props: [],
        },
      };

      await silentMapper.mapItem(item);

      expect(logger.warn).not.toHaveBeenCalled();
    });

    it('should still log debug messages when logWarnings is false', async () => {
      const silentMapper = new GoldskyItemsMapper({ logWarnings: false });
      const item: GoldskyItem = {
        id: 'item-ok',
        itemID: 'iok',
        submitter: '0xsubmitter',
        stake: '100',
        includedAt: '1700000000',
        status: 'Submitted',
        metadata: {
          key0: '1',
          key2: 'eip155:11155111:0xaddress',
          props: [],
        },
      };

      await silentMapper.mapItem(item);

      expect(logger.debug).toHaveBeenCalledWith(
        'Mapped item to event',
        expect.objectContaining({ itemId: 'item-ok' })
      );
    });

    it('should log warnings by default', async () => {
      const item: GoldskyItem = {
        id: 'item-bad2',
        itemID: 'ibad2',
        submitter: '0xsubmitter',
        stake: '100',
        includedAt: '1700000000',
        status: 'Submitted',
        metadata: {
          key0: 'abc',
          key2: 'eip155:11155111:0xaddress',
          props: [],
        },
      };

      await mapper.mapItem(item);

      expect(logger.warn).toHaveBeenCalled();
    });
  });

  describe('constructor configuration', () => {
    it('should use default CHAIN_ID from config (Sepolia)', async () => {
      const defaultMapper = new GoldskyItemsMapper();
      const item: GoldskyItem = {
        id: 'item',
        itemID: 'i',
        submitter: '0xsubmitter',
        stake: '1',
        includedAt: '1700000000',
        status: 'Submitted',
        metadata: {
          key0: '1',
          key2: 'eip155:11155111:0xaddress',
          props: [],
        },
      };

      const result = await defaultMapper.mapItem(item);
      expect(result).not.toBeNull();
    });

    it('should use config CHAIN_ID when constructor chainId not provided', async () => {
      (getConfig as jest.Mock).mockReturnValue({ CHAIN_ID: 5 });
      const defaultMapper = new GoldskyItemsMapper();
      const item: GoldskyItem = {
        id: 'item',
        itemID: 'i',
        submitter: '0xsubmitter',
        stake: '1',
        includedAt: '1700000000',
        status: 'Submitted',
        metadata: {
          key0: '1',
          key2: 'eip155:5:0xaddress',
          props: [],
        },
      };

      const result = await defaultMapper.mapItem(item);
      expect(result).not.toBeNull();
    });

    it('should respect custom chainId passed in constructor', async () => {
      const customMapper = new GoldskyItemsMapper({ chainId: 5 }); // Goerli
      const item: GoldskyItem = {
        id: 'item-goerli',
        itemID: 'ig',
        submitter: '0xsubmitter',
        stake: '1',
        includedAt: '1700000000',
        status: 'Submitted',
        metadata: {
          key0: '1',
          key2: 'eip155:5:0xaddress',
          props: [],
        },
      };

      const result = await customMapper.mapItem(item);
      expect(result).not.toBeNull();
    });

    it('should default to Sepolia (11155111) when both config and constructor omit', async () => {
      (getConfig as jest.Mock).mockReturnValue({}); // No CHAIN_ID
      const defaultMapper = new GoldskyItemsMapper();
      expect(defaultMapper).toBeDefined();
      // The targetChainId should be 11155111
      // We can test by trying to map an item with Sepolia chain
      const item: GoldskyItem = {
        id: 'item',
        itemID: 'i',
        submitter: '0xsubmitter',
        stake: '1',
        includedAt: '1700000000',
        status: 'Submitted',
        metadata: {
          key0: '1',
          key2: 'eip155:11155111:0xaddress',
          props: [],
        },
      };
      expect(await defaultMapper.mapItem(item)).not.toBeNull();
    });
  });

  describe('createGoldskyMapper convenience function', () => {
    it('should create a mapper instance with default options', () => {
      const mapper = createGoldskyMapper();
      expect(mapper instanceof GoldskyItemsMapper).toBe(true);
    });

    it('should create a mapper instance with custom options', () => {
      const mapper = createGoldskyMapper({ chainId: 1, pgtcrId: 10 });
      expect(mapper instanceof GoldskyItemsMapper).toBe(true);
    });
  });

  // New tests for identity check
  describe('with identity check enabled', () => {
    beforeEach(() => {
      jest.clearAllMocks();
      jest.spyOn(ethers, 'JsonRpcProvider').mockImplementation(() => ({}) as any);
      jest.spyOn(ethers, 'Contract').mockImplementation(() => ({ ownerOf: jest.fn() }) as any);
      // Override config for identity registry
      (getConfig as jest.Mock).mockReturnValue({
        CHAIN_ID: 11155111,
        IDENTITY_REGISTRY_ADDRESS: '0xIdentityRegistry',
        SEPOLIA_RPC: 'https://sepolia.example.com',
        PGTCR_ID: 1,
      });
    });

    afterEach(() => {
      jest.restoreAllMocks();
    });

    it('should initialize provider and contract when enableIdentityCheck is true', () => {
      const mapper = new GoldskyItemsMapper({ enableIdentityCheck: true });
      expect((mapper as any).identityRegistry).toBeDefined();
      expect((mapper as any).provider).toBeDefined();
    });

    it('should throw if IDENTITY_REGISTRY_ADDRESS missing', () => {
      (getConfig as jest.Mock).mockReturnValue({
        CHAIN_ID: 11155111,
        IDENTITY_REGISTRY_ADDRESS: undefined,
        SEPOLIA_RPC: 'https://sepolia.example.com',
      });
      expect(() => new GoldskyItemsMapper({ enableIdentityCheck: true })).toThrow('IDENTITY_REGISTRY_ADDRESS must be configured when enableIdentityCheck is true');
    });

    it('should throw if SEPOLIA_RPC missing', () => {
      (getConfig as jest.Mock).mockReturnValue({
        CHAIN_ID: 11155111,
        IDENTITY_REGISTRY_ADDRESS: '0xRegistry',
        SEPOLIA_RPC: undefined,
      });
      expect(() => new GoldskyItemsMapper({ enableIdentityCheck: true })).toThrow('SEPOLIA_RPC must be configured when enableIdentityCheck is true');
    });

    it('should skip item when Identity Registry returns zero address', async () => {
      const mapper = new GoldskyItemsMapper({ enableIdentityCheck: true });
      // Mock the identityRegistry contract
      const mockOwnerOf = jest.fn().mockImplementation(async () => ethers.ZeroAddress);
      (mapper as any).identityRegistry = { ownerOf: mockOwnerOf };
      const item: GoldskyItem = {
        id: 'item-zero-owner',
        itemID: 'izero',
        submitter: '0xsubmitter',
        stake: '100',
        includedAt: '1700000000',
        status: 'Submitted',
        metadata: {
          key0: '123',
          key2: 'eip155:11155111:0xaddress',
          props: [],
        },
      };
      const result = await mapper.mapItem(item);
      expect(result).toBeNull();
      expect(mockOwnerOf).toHaveBeenCalledWith(expect.stringMatching(/^0x[0-9a-f]{64}$/));
      expect(logger.warn).toHaveBeenCalledWith('Skipping item: agentId not found in Identity Registry', expect.objectContaining({ itemId: 'item-zero-owner' }));
    });

    it('should pass item when Identity Registry returns non-zero address', async () => {
      const mapper = new GoldskyItemsMapper({ enableIdentityCheck: true });
      const mockOwnerOf = jest.fn().mockImplementation(async () => '0xSomeOwner');
      (mapper as any).identityRegistry = { ownerOf: mockOwnerOf };
      const item: GoldskyItem = {
        id: 'item-pass',
        itemID: 'ipass',
        submitter: '0xsubmitter',
        stake: '100',
        includedAt: '1700000000',
        status: 'Submitted',
        metadata: {
          key0: '123',
          key2: 'eip155:11155111:0xaddress',
          props: [],
        },
      };
      const result = await mapper.mapItem(item);
      expect(result).not.toBeNull();
      expect(result!.id).toBe('item-pass');
    });

    it('should skip item when Identity Registry call throws', async () => {
      const mapper = new GoldskyItemsMapper({ enableIdentityCheck: true });
      const mockOwnerOf = jest.fn().mockImplementation(async () => { throw new Error('RPC failure'); });
      (mapper as any).identityRegistry = { ownerOf: mockOwnerOf };
      const item: GoldskyItem = {
        id: 'item-rpc-fail',
        itemID: 'ifail',
        submitter: '0xsubmitter',
        stake: '100',
        includedAt: '1700000000',
        status: 'Submitted',
        metadata: {
          key0: '123',
          key2: 'eip155:11155111:0xaddress',
          props: [],
        },
      };
      const result = await mapper.mapItem(item);
      expect(result).toBeNull();
      expect(logger.warn).toHaveBeenCalledWith('Skipping item: agentId not found in Identity Registry', expect.objectContaining({ itemId: 'item-rpc-fail' }));
    });

    it('should not perform identity check when enableIdentityCheck is false (default)', async () => {
      const mapper = new GoldskyItemsMapper({ enableIdentityCheck: false });
      expect((mapper as any).identityRegistry).toBeUndefined();
      const item: GoldskyItem = {
        id: 'item-no-check',
        itemID: 'inocheck',
        submitter: '0xsubmitter',
        stake: '100',
        includedAt: '1700000000',
        status: 'Submitted',
        metadata: {
          key0: '123',
          key2: 'eip155:11155111:0xaddress',
          props: [],
        },
      };
      const result = await mapper.mapItem(item);
      expect(result).not.toBeNull();
    });
  });
});
