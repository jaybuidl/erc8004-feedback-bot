import { getConfig } from './config';
import logger from './logger';
import type { CollateralizationEvent } from './types';
import { ethers } from 'ethers';

/**
 * Goldsky item node interface (from GraphQL query)
 */
export interface GoldskyItem {
  id: string;
  itemID: string;
  submitter: string;
  stake: string;
  includedAt: string;
  status: string;
  metadata: {
    key0?: string;
    key2?: string;
    /** Additional metadata properties (ignored by strict mapper) */
    props?: any[];
    [key: string]: any; // Allow other keys for flexibility
  };
}

/**
 * Configuration for the GoldskyItemsMapper
 */
export interface GoldskyMapperConfig {
  /** Chain ID to filter for (default: 11155111 for Sepolia) */
  chainId?: number;
  /** Whether to emit warnings for skipped items (default: true) */
  logWarnings?: boolean;
  /** PGTCR identifier for the resulting events (default: 1). Must be a positive integer. */
  pgtcrId?: number;
  /** Enable identity registry sanity check (default: false). Requires IDENTITY_REGISTRY_ADDRESS and SEPOLIA_RPC. */
  enableIdentityCheck?: boolean;
  /** Override Identity Registry address (useful for testing or multi-chain). Defaults to config.IDENTITY_REGISTRY_ADDRESS. */
  identityRegistryAddress?: string;
  /** Override Sepolia RPC endpoint for identity registry queries. Defaults to config.SEPOLIA_RPC. */
  sepoliaRpc?: string;
}

/**
 * Strict mapper for converting Goldsky 'items' records to ERC-8004 agentId.
 *
 * Rules:
 * - agentId MUST come from metadata.key0 (numeric string only, no fallback)
 * - Parse chain from metadata.key2 (CAIP10: eip155:<chainId>:<addr>)
 * - Only process if chainId == target chain (default Sepolia: 11155111)
 * - Skip and log clear warnings for missing/invalid key0 or non-Sepolia chains
 *
 * Uses ethers v6 BigInt handling.
 */
export class GoldskyItemsMapper {
  private readonly targetChainId: number;
  private readonly shouldLogWarnings: boolean;
  private readonly pgtcrId: number;
  private readonly enableIdentityCheck: boolean;
  private readonly identityRegistryAddress?: string;
  private readonly sepoliaRpc?: string;
  private provider?: ethers.JsonRpcProvider;
  private identityRegistry?: ethers.Contract;

  constructor(config: GoldskyMapperConfig = {}) {
    const appConfig = getConfig();
    this.targetChainId = config.chainId ?? appConfig.CHAIN_ID ?? 11155111;
    this.shouldLogWarnings = config.logWarnings ?? true;
    // Use provided pgtcrId or default to 1; ensure it's a positive integer
    const rawPgtcrId = config.pgtcrId ?? 1;
    if (!Number.isInteger(rawPgtcrId) || rawPgtcrId <= 0) {
      throw new Error(`pgtcrId must be a positive integer, got ${rawPgtcrId}`);
    }
    this.pgtcrId = rawPgtcrId;

    // Identity Registry check configuration
    this.enableIdentityCheck = config.enableIdentityCheck ?? false;
    if (this.enableIdentityCheck) {
      this.identityRegistryAddress = config.identityRegistryAddress ?? appConfig.IDENTITY_REGISTRY_ADDRESS;
      this.sepoliaRpc = config.sepoliaRpc ?? appConfig.SEPOLIA_RPC;
      if (!this.identityRegistryAddress) {
        throw new Error('IDENTITY_REGISTRY_ADDRESS must be configured when enableIdentityCheck is true');
      }
      if (!this.sepoliaRpc) {
        throw new Error('SEPOLIA_RPC must be configured when enableIdentityCheck is true');
      }
      // Initialize provider and contract for read-only queries
      this.provider = new ethers.JsonRpcProvider(this.sepoliaRpc);
      this.identityRegistry = new ethers.Contract(
        this.identityRegistryAddress,
        ['function ownerOf(bytes32) view returns (address)'],
        this.provider
      );
    }
  }

  /**
   * Convert a single Goldsky item to a CollateralizationEvent.
   * Returns null if the item fails validation.
   */
  async mapItem(item: GoldskyItem): Promise<CollateralizationEvent | null> {
    // Guard: metadata must exist
    if (!item.metadata) {
      this.logWarning('Skipping item: metadata is null or undefined', { itemId: item.id });
      return null;
    }

    // 1. Check metadata.key2 for CAIP10 and extract chainId
    const rawKey2 = item.metadata.key2;
    let caip10 = rawKey2;
    if (caip10 === undefined || caip10 === null) {caip10 = '';}
    caip10 = caip10.trim();
    if (!caip10) {
      this.logWarning('Skipping item: metadata.key2 (CAIP10) is missing', { itemId: item.id });
      return null;
    }

    const chainId = this.parseChainIdFromCAIP10(caip10);
    if (chainId === null) {
      this.logWarning('Skipping item: metadata.key2 is not a valid CAIP10 format', { itemId: item.id, key2: rawKey2 });
      return null;
    }

    if (chainId !== this.targetChainId) {
      const chainName = this.targetChainId === 11155111 ? 'Sepolia' : this.targetChainId.toString();
      this.logWarning(`Skipping item: chain ID does not match target ${chainName}`, { itemId: item.id, chainId, expectedChainId: this.targetChainId });
      return null;
    }

    // 2. Extract agent ID ONLY from metadata.key0 (must be a numeric string)
    const rawKey0 = item.metadata.key0;
    let key0 = rawKey0;
    if (key0 === undefined || key0 === null) {key0 = '';}
    if (typeof key0 === 'string') {
      key0 = key0.trim();
    }
    if (key0 === '' || !/^\d+$/.test(key0)) {
      this.logWarning('Skipping item: metadata.key0 is missing, empty, or not a valid integer string', { itemId: item.id, key0: rawKey0 });
      return null;
    }
    const agentIdStr = key0;

    // 3. Convert agentId string to bytes32 hex using BigInt, with overflow check
    let agentId: string;
    try {
      agentId = this.agentIdToBytes32(agentIdStr);
    } catch (err) {
      this.logWarning('Skipping item: failed to convert agentId to bytes32', { itemId: item.id, agentIdStr, error: err });
      return null;
    }

    // Optional Identity Registry sanity check
    if (this.enableIdentityCheck) {
      const exists = await this.verifyAgentId(agentId);
      if (!exists) {
        this.logWarning('Skipping item: agentId not found in Identity Registry', { itemId: item.id, agentId });
        return null;
      }
    }

    // 4. Build and return event
    try {
      const amount = BigInt(item.stake);
      const includedAt = Number(item.includedAt);
      // Validate timestamp: must be a finite, non-negative number
      if (!Number.isFinite(includedAt) || Number.isNaN(includedAt) || includedAt < 0) {
        throw new Error(`Invalid includedAt value: ${item.includedAt}`);
      }

      const event: CollateralizationEvent = {
        id: item.id,
        agent: agentId,
        amount,
        status: 'registered',
        timestamp: includedAt,
        pgtcrId: this.pgtcrId,
      };

      this.logDebug('Mapped item to event', { itemId: item.id, agentId, amount });
      return event;
    } catch (err) {
      this.logWarning('Skipping item: failed to parse stake or timestamp', { itemId: item.id, error: err });
      return null;
    }
  }

  /**
   * Batch map items to events, filtering out invalid ones.
   * Returns only the successfully mapped events.
   */
  async mapItems(items: GoldskyItem[]): Promise<CollateralizationEvent[]> {
    const events: CollateralizationEvent[] = [];
    for (const item of items) {
      const event = await this.mapItem(item);
      if (event !== null) {
        events.push(event);
      }
    }
    return events;
  }

  /**
   * Parse chainId from CAIP10 string: eip155:<chainId>:<address>
   * Returns null if format is invalid.
   */
  private parseChainIdFromCAIP10(caip10: string): number | null {
    // Expected format: eip155:<chainId>:<address>
    const parts = caip10.split(':');
    if (parts.length >= 2 && parts[0] === 'eip155') {
      const chainId = parseInt(parts[1], 10);
      return isNaN(chainId) ? null : chainId;
    }
    return null;
  }

  /**
   * Verify that the given agentId (bytes32) exists in the Identity Registry.
   * Returns true if the agentId has a non-zero owner, false otherwise.
   */
  private async verifyAgentId(agentId: string): Promise<boolean> {
    if (!this.identityRegistry) {
      throw new Error('Identity Registry not initialized');
    }
    try {
      const owner = await this.identityRegistry.ownerOf(agentId);
      return owner !== ethers.ZeroAddress;
    } catch (error) {
      // If the token does not exist or call fails, treat as not registered.
      this.logDebug('Identity Registry check failed', { agentId, error: (error as Error).message });
      return false;
    }
  }

  /**
   * Converts a numeric agent ID string to a bytes32 hex string (0x-padded 64 hex chars).
   * Checks for overflow beyond uint256/bytes32 max.
   */
  private agentIdToBytes32(agentIdStr: string): string {
    const big = BigInt(agentIdStr);
    // Overflow check: bytes32 max = 2^256 - 1
    const maxBytes32 = (2n ** 256n) - 1n;
    if (big > maxBytes32) {
      throw new Error(`agentId ${agentIdStr} exceeds bytes32 max`);
    }
    const hex = big.toString(16);
    const padded = hex.padStart(64, '0');
    return `0x${padded}`;
  }

  private logWarning(message: string, meta: Record<string, any> = {}): void {
    if (this.shouldLogWarnings) {
      logger.warn(message, meta);
    }
  }

  private logDebug(message: string, meta: Record<string, any> = {}): void {
    logger.debug(message, meta);
  }
}

/**
 * Convenience function to create a mapper with default config
 */
export function createGoldskyMapper(config?: GoldskyMapperConfig): GoldskyItemsMapper {
  return new GoldskyItemsMapper(config);
}
