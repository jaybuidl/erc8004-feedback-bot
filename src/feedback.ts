import { ethers } from 'ethers';
import reputationRegistryAbi from './blockchain/abis/reputation-registry.json';
import { getConfig } from './config';
import logger from './logger';
import { walletManager } from './wallet';
import { withRetry, DEFAULT_RETRY_CONFIG, isRetryableError } from './utils/retry';
import type { AgentId, AgentFeedback } from './types';

type SendFeedbackResult = {
  success: boolean;
  txHash?: string;
  agentId?: AgentId;
  feedbackIndex?: number;
  error?: Error;
};

export type RevokeFeedbackResult = {
  success: boolean;
  txHash?: string;
  agentId?: AgentId;
  feedbackIndex: number;
  error?: Error;
};

export interface OnchainFeedbackRecord {
  feedbackIndex: number;
  value: string;
  decimals: number;
  tag1: string;
  tag2: string;
  revoked: boolean;
}

export interface FeedbackSignature {
  value: number;
  decimals: number;
  tag1: string;
  tag2: string;
}

function isHexString(value: string): boolean {
  return /^0x[0-9a-fA-F]*$/.test(value);
}

function padToBytes32(hex: string): string {
  const withoutPrefix = hex.startsWith('0x') ? hex.slice(2) : hex;
  const padded = withoutPrefix.padStart(64, '0');
  return `0x${padded}`;
}

function validateAgentId(agentId: AgentId): string {
  let hex = agentId;
  if (!agentId.startsWith('0x')) {
    try {
      const big = BigInt(agentId);
      hex = `0x${big.toString(16)}`;
    } catch {
      throw new Error('Invalid agentId: not a hex or decimal string');
    }
  }
  if (!isHexString(hex)) {
    throw new Error('Invalid agentId: not a valid hex string');
  }
  if (hex.length > 66) {
    throw new Error('agentId exceeds uint256 capacity');
  }
  return hex;
}

function validateInt128(value: number): boolean {
  const min = -(2n ** 127n);
  const max = (2n ** 127n) - 1n;
  const big = BigInt(value);
  return big >= min && big <= max;
}

function validateFeedbackHash(hash: string): string {
  if (!hash) {
    return padToBytes32('0x0');
  }
  let hex = hash;
  if (!hash.startsWith('0x')) {
    hex = `0x${hash}`;
  }
  if (!/^0x[0-9a-fA-F]*$/.test(hex)) {
    throw new Error('feedbackHash must be a hex string');
  }
  if (hex.length > 66) {
    throw new Error('feedbackHash exceeds bytes32 length');
  }
  return padToBytes32(hex);
}

export class FeedbackSender {
  private reputationRegistry: ethers.Contract | null = null;
  private initialized = false;
  private signerAddress: string | null = null;

  async init(): Promise<void> {
    if (this.initialized) {return;}

    await walletManager.init();
    const signer = walletManager.getSigner();
    const config = getConfig();

    this.reputationRegistry = new ethers.Contract(
      config.REPUTATION_REGISTRY_ADDRESS,
      reputationRegistryAbi,
      signer
    );
    this.signerAddress = (await signer.getAddress()).toLowerCase();
    this.initialized = true;

    logger.info('FeedbackSender initialized', {
      address: config.REPUTATION_REGISTRY_ADDRESS,
      signerAddress: this.signerAddress,
    });
  }

  async getSignerAddress(): Promise<string> {
    if (!this.initialized || !this.signerAddress) {
      await this.init();
    }
    return this.signerAddress!;
  }

  async listOwnFeedback(agentId: AgentId): Promise<OnchainFeedbackRecord[]> {
    if (!this.initialized || !this.reputationRegistry) {
      await this.init();
    }

    const validatedAgentId = validateAgentId(agentId);
    const signerAddress = await this.getSignerAddress();
    const config = getConfig();

    const lastIndexRaw = await this.reputationRegistry!.getLastIndex(validatedAgentId, signerAddress);
    const lastIndex = Number(lastIndexRaw);
    if (!Number.isFinite(lastIndex) || lastIndex <= 0) {
      return [];
    }

    const scanLimit = Math.max(1, config.ONCHAIN_FEEDBACK_SCAN_LIMIT);
    const startIndex = Math.max(1, lastIndex - scanLimit + 1);
    const records: OnchainFeedbackRecord[] = [];

    for (let feedbackIndex = startIndex; feedbackIndex <= lastIndex; feedbackIndex++) {
      try {
        const result = await this.reputationRegistry!.readFeedback(
          validatedAgentId,
          signerAddress,
          feedbackIndex
        );
        records.push({
          feedbackIndex,
          value: result[0].toString(),
          decimals: Number(result[1]),
          tag1: result[2],
          tag2: result[3],
          revoked: Boolean(result[4]),
        });
      } catch (error) {
        logger.debug('Failed to read feedback entry, skipping index', {
          agentId: validatedAgentId,
          feedbackIndex,
          error: (error as Error).message,
        });
      }
    }

    return records;
  }

  async findMatchingActiveFeedbackIndices(
    agentId: AgentId,
    signature: FeedbackSignature
  ): Promise<number[]> {
    const entries = await this.listOwnFeedback(agentId);
    return entries
      .filter((entry) =>
        !entry.revoked &&
        entry.value === BigInt(signature.value).toString() &&
        entry.decimals === signature.decimals &&
        entry.tag1 === signature.tag1 &&
        entry.tag2 === signature.tag2
      )
      .map((entry) => entry.feedbackIndex);
  }

  private extractFeedbackIndex(receipt: ethers.TransactionReceipt, agentId: string): number | undefined {
    if (!this.reputationRegistry || !this.signerAddress) {
      return undefined;
    }

    const expectedAgentId = BigInt(agentId);
    for (const log of receipt.logs) {
      try {
        const parsed = this.reputationRegistry.interface.parseLog(log);
        if (parsed?.name !== 'NewFeedback') {
          continue;
        }
        const logAgentId = parsed.args.agentId as bigint;
        const clientAddress = String(parsed.args.clientAddress).toLowerCase();
        if (logAgentId === expectedAgentId && clientAddress === this.signerAddress) {
          return Number(parsed.args.feedbackIndex);
        }
      } catch {
        // Ignore unrelated logs
      }
    }
    return undefined;
  }

  async sendFeedback(
    agentId: AgentId,
    value: number = getConfig().FEEDBACK_VALUE,
    decimals: number = getConfig().FEEDBACK_DECIMALS,
    tag1: string = getConfig().FEEDBACK_TAG1,
    tag2: string = getConfig().FEEDBACK_TAG2,
    endpoint: string = getConfig().FEEDBACK_ENDPOINT,
    feedbackURI: string = getConfig().FEEDBACK_URI,
    feedbackHash: string = getConfig().FEEDBACK_HASH
  ): Promise<SendFeedbackResult> {
    if (!this.initialized || !this.reputationRegistry) {
      await this.init();
    }

    const config = getConfig();
    let validatedAgentId: string;
    try {
      validatedAgentId = validateAgentId(agentId);
    } catch (err) {
      logger.error('Invalid agentId', { agentId, error: err });
      return { success: false, agentId, error: err as Error };
    }

    if (!validateInt128(value)) {
      const err = new Error(`value ${value} out of int128 range`);
      logger.error('Invalid feedback value', { value, error: err });
      return { success: false, agentId: validatedAgentId, error: err };
    }

    if (decimals < 0 || decimals > 255) {
      const err = new Error(`decimals ${decimals} must be 0-255 (uint8)`);
      logger.error('Invalid decimals', { decimals, error: err });
      return { success: false, agentId: validatedAgentId, error: err };
    }

    if (
      tag1 === null || tag1 === undefined ||
      tag2 === null || tag2 === undefined ||
      endpoint === null || endpoint === undefined ||
      feedbackURI === null || feedbackURI === undefined
    ) {
      const err = new Error('tag1, tag2, endpoint, feedbackURI must be non-null strings');
      logger.error('Missing required string parameters', { tag1, tag2, endpoint, feedbackURI });
      return { success: false, agentId: validatedAgentId, error: err };
    }

    let validatedFeedbackHash: string;
    try {
      validatedFeedbackHash = validateFeedbackHash(feedbackHash);
    } catch (err) {
      logger.error('Invalid feedbackHash', { feedbackHash, error: err });
      return { success: false, agentId: validatedAgentId, error: err as Error };
    }

    if (config.DRY_RUN) {
      logger.info('[DRY RUN] Would send feedback', {
        agentId: validatedAgentId,
        value,
        decimals,
        tag1,
        tag2,
        endpoint,
        feedbackURI,
        feedbackHash: validatedFeedbackHash,
      });
      return { success: true, agentId: validatedAgentId, txHash: '0xDRYRUN' };
    }

    try {
      logger.info('Sending feedback transaction', {
        agentId: validatedAgentId,
        value,
        decimals,
        tag1,
        tag2,
        endpoint,
        feedbackURI,
        feedbackHash: validatedFeedbackHash,
      });

      const amountInt = BigInt(value);

      const sendOperation = async () => {
        const gasEstimate = await this.reputationRegistry!.giveFeedback.estimateGas(
          validatedAgentId,
          amountInt,
          decimals,
          tag1,
          tag2,
          endpoint,
          feedbackURI,
          validatedFeedbackHash
        );
        const gasLimit = (gasEstimate * BigInt(config.GAS_BUFFER_MULTIPLIER)) / 100n;

        return this.reputationRegistry!.giveFeedback(
          validatedAgentId,
          amountInt,
          decimals,
          tag1,
          tag2,
          endpoint,
          feedbackURI,
          validatedFeedbackHash,
          { gasLimit }
        );
      };

      const tx = await withRetry(
        sendOperation,
        DEFAULT_RETRY_CONFIG,
        'sendFeedback',
        isRetryableError
      );

      logger.info('Feedback transaction submitted', {
        txHash: tx.hash,
        agentId: validatedAgentId,
      });

      const receipt = await tx.wait(1);
      const feedbackIndex = this.extractFeedbackIndex(receipt, validatedAgentId);

      logger.info('Feedback transaction confirmed', {
        txHash: receipt.hash,
        blockNumber: receipt.blockNumber,
        gasUsed: receipt.gasUsed.toString(),
        feedbackIndex,
      });

      return {
        success: true,
        txHash: receipt.hash,
        agentId: validatedAgentId,
        feedbackIndex,
      };
    } catch (error) {
      logger.error('Feedback transaction failed', {
        agentId: validatedAgentId,
        error: (error as Error).toString(),
      });
      return { success: false, agentId: validatedAgentId, error: error as Error };
    }
  }

  async revokeFeedback(agentId: AgentId, feedbackIndex: number): Promise<RevokeFeedbackResult> {
    if (!this.initialized || !this.reputationRegistry) {
      await this.init();
    }

    const config = getConfig();
    let validatedAgentId: string;
    try {
      validatedAgentId = validateAgentId(agentId);
    } catch (err) {
      return { success: false, feedbackIndex, agentId, error: err as Error };
    }

    if (config.DRY_RUN) {
      logger.info('[DRY RUN] Would revoke feedback', {
        agentId: validatedAgentId,
        feedbackIndex,
      });
      return { success: true, txHash: '0xDRYRUNREVOKE', agentId: validatedAgentId, feedbackIndex };
    }

    try {
      const sendOperation = async () => {
        const gasEstimate = await this.reputationRegistry!.revokeFeedback.estimateGas(
          validatedAgentId,
          feedbackIndex
        );
        const gasLimit = (gasEstimate * BigInt(config.GAS_BUFFER_MULTIPLIER)) / 100n;
        return this.reputationRegistry!.revokeFeedback(validatedAgentId, feedbackIndex, { gasLimit });
      };

      const tx = await withRetry(
        sendOperation,
        DEFAULT_RETRY_CONFIG,
        'revokeFeedback',
        isRetryableError
      );
      const receipt = await tx.wait(1);

      logger.info('Feedback revocation confirmed', {
        agentId: validatedAgentId,
        feedbackIndex,
        txHash: receipt.hash,
        blockNumber: receipt.blockNumber,
      });

      return {
        success: true,
        txHash: receipt.hash,
        agentId: validatedAgentId,
        feedbackIndex,
      };
    } catch (error) {
      logger.error('Feedback revocation failed', {
        agentId: validatedAgentId,
        feedbackIndex,
        error: (error as Error).toString(),
      });
      return {
        success: false,
        agentId: validatedAgentId,
        feedbackIndex,
        error: error as Error,
      };
    }
  }

  async sendBatch(agents: AgentFeedback[]): Promise<SendFeedbackResult[]> {
    const results: SendFeedbackResult[] = [];
    const config = getConfig();

    for (const agent of agents) {
      const result = await this.sendFeedback(
        agent.agentId,
        agent.value,
        agent.decimals,
        agent.tag1,
        agent.tag2,
        agent.endpoint,
        agent.feedbackURI,
        agent.feedbackHash
      );
      results.push(result);
      await this.delay(config.FEEDBACK_BATCH_INTERVAL_MS);
    }

    return results;
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

export const feedbackSender = new FeedbackSender();
export type FeedbackSenderType = FeedbackSender;
