import { GraphQLClient, gql } from 'graphql-request';
import { getConfig } from './config';
import logger from './logger';
import { GoldskyItemsMapper, type GoldskyItem } from './goldsky-items-mapper';
import type { CollateralizationEvent } from './types';
import { withRetry, DEFAULT_RETRY_CONFIG } from './utils/retry';

// GraphQL query for PGTCR items with metadata.
// Uses status_in to optionally include both Submitted and Reincluded.
const PGTCR_ITEMS_QUERY = gql`
  query GetItems(
    $where: Item_filter!
    $first: Int!
    $skip: Int
    $orderBy: Item_orderBy
    $orderDirection: OrderDirection
  ) {
    items(
      where: $where
      first: $first
      skip: $skip
      orderBy: $orderBy
      orderDirection: $orderDirection
    ) {
      id
      itemID
      submitter
      stake
      includedAt
      status
      metadata {
        key0
        key2
      }
    }
  }
`;

interface ItemsResponse {
  items: GoldskyItem[];
}

export class GoldskyClient {
  private client: GraphQLClient;
  private pageSize: number;
  private itemMapper: GoldskyItemsMapper;

  constructor(endpoint?: string, pageSize?: number) {
    const config = getConfig();
    const endpointUrl = endpoint ?? config.GOLDSKY_ENDPOINT;
    const timeoutMs = config.GOLDSKY_TIMEOUT_MS;

    // Create a GraphQLClient with a custom fetch that enforces a timeout
    this.client = new GraphQLClient(endpointUrl, {
      fetch: (url, init) => {
        // Use AbortSignal.timeout if available (Node 20+)
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), timeoutMs);
        // We ignore any signal passed in init to avoid complications; this is a per-request timeout
        return fetch(url, { ...init, signal: controller.signal }).finally(() => {
          clearTimeout(timeout);
        });
      },
    });

    this.pageSize = pageSize ?? config.GOLDSKY_PAGE_SIZE;
    this.itemMapper = new GoldskyItemsMapper({ chainId: config.CHAIN_ID, pgtcrId: config.PGTCR_ID });
  }

  /**
   * Fetch active collateralizations (items with status Submitted or Reincluded, stake > 0, included before age threshold)
   */
  async fetchActiveCollateralizations(): Promise<CollateralizationEvent[]> {
    const config = getConfig();
    logger.info('Fetching active collateralizations from Goldsky');
    const now = Math.floor(Date.now() / 1000);
    const minAgeSeconds = config.MIN_AGE_SECONDS;
    const minAgeTimestamp = BigInt(Math.ceil(now - minAgeSeconds));

    // Always include both Submitted and Reincluded statuses per latest specs
    const statusIn = ['Submitted', 'Reincluded'];

    const where: Record<string, any> = {
      status_in: statusIn,
      stake_gt: '0',
      includedAt_lt: minAgeTimestamp.toString(),
    };
    if (config.PGTCR_REGISTRY_ADDRESS) {
      where.registryAddress = config.PGTCR_REGISTRY_ADDRESS;
    } else {
      logger.warn('PGTCR_REGISTRY_ADDRESS not configured; fetching items from all registries');
    }
    const orderBy = 'includedAt';
    const orderDirection: 'asc' | 'desc' = 'desc';
    return this.paginateFetch(where, orderBy, orderDirection);
  }

  async fetchCurrentActiveCollateralizations(): Promise<CollateralizationEvent[]> {
    const config = getConfig();
    logger.info('Fetching current active collateralizations from Goldsky');

    const where: Record<string, any> = {
      status_in: ['Submitted', 'Reincluded'],
      stake_gt: '0',
    };
    if (config.PGTCR_REGISTRY_ADDRESS) {
      where.registryAddress = config.PGTCR_REGISTRY_ADDRESS;
    }

    return this.paginateFetch(where, 'includedAt', 'desc');
  }

  /**
   * Fetch collateralizations since a given timestamp (for incremental sync)
   */
  async fetchCollateralizationsSince(timestamp: number): Promise<CollateralizationEvent[]> {
    const config = getConfig();
    logger.info('Fetching collateralizations since timestamp', { timestamp });

    // Always include both Submitted and Reincluded statuses per latest specs
    const statusIn = ['Submitted', 'Reincluded'];

    const where: Record<string, any> = {
      status_in: statusIn,
      stake_gt: '0',
      includedAt_gte: timestamp,
    };
    if (config.PGTCR_REGISTRY_ADDRESS) {
      where.registryAddress = config.PGTCR_REGISTRY_ADDRESS;
    }
    const orderBy = 'includedAt';
    const orderDirection: 'asc' | 'desc' = 'asc';
    return this.paginateFetch(where, orderBy, orderDirection);
  }

  private async paginateFetch(
    where: Record<string, any>,
    orderBy: string,
    orderDirection: 'asc' | 'desc'
  ): Promise<CollateralizationEvent[]> {
    const config = getConfig();
    const allEvents: CollateralizationEvent[] = [];
    let skip = 0;
    let hasNextPage = true;
    while (hasNextPage) {
      const variables = {
        first: this.pageSize,
        skip,
        where,
        orderBy,
        orderDirection,
      };
      try {
        const data = await withRetry(
          () => this.client.request<ItemsResponse>(PGTCR_ITEMS_QUERY, variables),
          { ...DEFAULT_RETRY_CONFIG, maxRetries: 3 },
          'Goldsky paginateFetch query'
        );
        // Transform events using the strict mapper
        const events = await this.transformEvents(data.items);
        allEvents.push(...events);
        hasNextPage = data.items.length === this.pageSize;
        skip += this.pageSize;
        if (hasNextPage) {
          await new Promise<void>((resolve) => setTimeout(resolve, config.PAGINATION_DELAY_MS));
        }
      } catch (error) {
        logger.error('Goldsky query failed', { error, where, skip });
        throw error;
      }
    }
    return allEvents;
  }

  /**
   * Transform raw Goldsky items to CollateralizationEvents.
   * Delegates to GoldskyItemsMapper for strict validation.
   */
  private async transformEvents(items: GoldskyItem[]): Promise<CollateralizationEvent[]> {
    return await this.itemMapper.mapItems(items);
  }

  async healthCheck(): Promise<boolean> {
    try {
      await this.executeQuery(
        { status_in: ['Submitted', 'Reincluded'], stake_gt: '0' },
        'includedAt',
        'desc',
        0
      );
      return true;
    } catch {
      return false;
    }
  }

  private async executeQuery(
    where: Record<string, any>,
    orderBy: string,
    orderDirection: 'asc' | 'desc',
    skip: number
  ): Promise<ItemsResponse> {
    const variables = {
      first: this.pageSize,
      skip,
      where,
      orderBy,
      orderDirection,
    };
    return withRetry(
      () => this.client.request<ItemsResponse>(PGTCR_ITEMS_QUERY, variables),
      DEFAULT_RETRY_CONFIG,
      'Goldsky executeQuery'
    );
  }
}

export const goldskyClient = new GoldskyClient();
export type GoldskyClientType = GoldskyClient;
