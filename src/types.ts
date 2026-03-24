export type CollateralizationStatus = 'registered' | 'withdrawn' | 'challenged';

export interface CollateralizationEvent {
  id: string;
  agent: string;
  amount: bigint;
  status: CollateralizationStatus;
  timestamp: number;
  pgtcrId: number;
}

export interface AgentEligibility {
  agent: string;
  collateralizationId: string;
  collateralizationSince: number;
  pgtcrId: number;
  amount: bigint;
  chainId: number; // Added for multi-chain support
}

export interface GoldskyResponse<T> {
  data: {
    [key: string]: T[];
  };
}

export interface GoldskyPaginatedResponse<T> {
  data: T[];
  pageInfo: {
    hasNextPage: boolean;
    endCursor?: string;
  };
}

export interface MapperConfig {
  identityRegistryAddress?: string;
}

export interface FeedbackConfig {
  reputationRegistryAddress: string;
  feedbackValue: number;
  feedbackTags: string[];
  maxBatchSize: number;
  dryRun: boolean;
}

export interface OrchestratorStats {
  totalEvents: number;
  eligibleAgents: number;
  feedbackSent: number;
  errorsCount: number;
  runId: string;
  durationMs: number;
}

export type LogMeta = Partial<{
  component: string;
  runId: string;
  agentCount: number;
  txHash: string;
  stats: OrchestratorStats;
  error: Error;
}>;

// bytes32 hex string (0x-prefixed 64 hex chars)
export type AgentId = string;

export interface AgentFeedback {
  agentId: AgentId;
  value: number;
  decimals: number;
  tag1: string;
  tag2: string;
  endpoint: string;
  feedbackURI: string;
  feedbackHash: string;
}
