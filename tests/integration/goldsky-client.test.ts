import { GraphQLClient } from 'graphql-request';
import { GoldskyClient } from '../../src/goldsky-client';
import { getConfig } from '../../src/config';

jest.mock('../../src/config', () => {
  const mockConfig = {
    GOLDSKY_ENDPOINT: 'https://test.example.com/graphql',
    GOLDSKY_PAGE_SIZE: 100,
    GOLDSKY_TIMEOUT_MS: 30000,
    PGTCR_REGISTRY_ADDRESS: '',
    NODE_ENV: 'test',
    LOG_LEVEL: 'info',
    ENABLE_METRICS: false,
    DATABASE_PATH: ':memory:',
    MIN_AGE_HOURS: 72,
    MIN_AGE_SECONDS: 72 * 60 * 60,
    CHAIN_ID: 11155111,
    PGTCR_ID: 1,
  };
  return {
    getConfig: jest.fn().mockReturnValue(mockConfig),
    resetConfig: jest.fn(),
  };
});

describe('GoldskyClient Integration', () => {
  const includedAtOne = Math.floor(Date.now() / 1000) - 10 * 24 * 60 * 60;
  const includedAtTwo = Math.floor(Date.now() / 1000) - 9 * 24 * 60 * 60;

  const mockItems = [
    {
      id: 'item-1',
      itemID: '0xitem-1',
      submitter: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      stake: '1000000000000000000',
      includedAt: String(includedAtOne),
      status: 'Submitted',
      metadata: {
        key0: '200',
        key2: 'eip155:11155111:0xaddress1',
      },
    },
    {
      id: 'item-2',
      itemID: '0xitem-2',
      submitter: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      stake: '2000000000000000000',
      includedAt: String(includedAtTwo),
      status: 'Reincluded',
      metadata: {
        key0: '300',
        key2: 'eip155:11155111:0xaddress2',
      },
    },
  ];

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('should fetch and map items using the Goldsky client', async () => {
    (getConfig as jest.Mock).mockReturnValue({
      ...(getConfig() as any),
      PGTCR_REGISTRY_ADDRESS: '0x1234567890123456789012345678901234567890',
    });

    jest.spyOn(GraphQLClient.prototype, 'request').mockResolvedValue({
      items: mockItems,
    } as any);

    const client = new GoldskyClient();
    const result = await client.fetchCurrentActiveCollateralizations();

    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({
      id: 'item-1',
      agent: '0x' + '0'.repeat(62) + 'c8',
      amount: 1000000000000000000n,
      timestamp: includedAtOne,
      status: 'registered',
      pgtcrId: 1,
    });
    expect(result[1]).toMatchObject({
      id: 'item-2',
      agent: '0x' + '0'.repeat(61) + '12c',
      amount: 2000000000000000000n,
      timestamp: includedAtTwo,
      status: 'registered',
      pgtcrId: 1,
    });
  });
});
