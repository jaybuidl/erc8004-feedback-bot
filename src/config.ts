import { z } from 'zod';
import dotenv from 'dotenv';
import path from 'path';

// Load environment variables from .env file, except in test mode where tests set their own env
if (process.env.NODE_ENV !== 'test') {
  dotenv.config();
}

// Chain-specific configuration schema (all fields optional as overrides)
const chainConfigSchema = z.object({
  GOLDSKY_ENDPOINT: z.string().url().optional(),
  IDENTITY_REGISTRY_ADDRESS: z.string().regex(/^0x[a-fA-F0-9]{40}$/).optional().or(z.literal('')),
  REPUTATION_REGISTRY_ADDRESS: z.string().regex(/^0x[a-fA-F0-9]{40}$/).optional(),
  PGTCR_REGISTRY_ADDRESS: z.string().regex(/^0x[a-fA-F0-9]{40}$/).optional(),
  CHAIN_ID: z.number().int().positive().optional(),
  PGTCR_ID: z.number().int().positive().optional(),
});

// Define chains mapping type
type ChainsMap = Record<string, z.input<typeof chainConfigSchema>>;

// Main config schema - separates chain-agnostic from chain-specific
const configSchema = z.object({
  // Environment
  NODE_ENV: z.enum(['development', 'production', 'test']).default('production'),

  // Chain selection (optional, for multi-chain mode)
  CHAIN: z.string().optional(),

  // Per-chain configurations (optional, JSON-encoded env var)
  CHAINS: z.record(chainConfigSchema).optional(),

  // Legacy top-level chain-specific configs (backward compatibility)
  GOLDSKY_ENDPOINT: z.string().url().optional(),
  IDENTITY_REGISTRY_ADDRESS: z.string().regex(/^0x[a-fA-F0-9]{40}$/).optional().or(z.literal('')),
  REPUTATION_REGISTRY_ADDRESS: z.string().regex(/^0x[a-fA-F0-9]{40}$/).optional(),
  PGTCR_REGISTRY_ADDRESS: z.string().regex(/^0x[a-fA-F0-9]{40}$/).optional(),
  // CHAIN_ID: chain selector with default Sepolia (11155111). Can be overridden by env or chain-specific config.
  CHAIN_ID: z.number().int().positive().default(11155111),

  // RPC endpoint for Sepolia (used to connect wallet provider and optionally for direct blockchain queries)
  // If not set, the wallet will have no provider and RPC-dependent calls will fail.
  SEPOLIA_RPC: z.string().url().optional(),

  // Non-chain-specific (global)
  PRIVATE_KEY: z.string().regex(/^(0x)?[a-fA-F0-9]{64}$/).optional(),
  MNEMONIC: z.string().optional(),
  FEEDBACK_VALUE: z.coerce.number().int().default(1),
  FEEDBACK_DECIMALS: z.coerce.number().int().min(0).max(255).default(0),
  FEEDBACK_TAG1: z.string().default(''),
  FEEDBACK_TAG2: z.string().default(''),
  FEEDBACK_ENDPOINT: z.string().default(''),
  FEEDBACK_URI: z.string().default(''),
  FEEDBACK_HASH: z.string().default('0x0000000000000000000000000000000000000000000000000000000000000000'),
  FEEDBACK_TITLE_TEMPLATE: z.string().default('PGTCR collateralization active'),
  FEEDBACK_TEXT_TEMPLATE: z.string().default(
    'Agent {{agentIdDecimal}} has remained actively collateralized in PGTCR {{pgtcrId}} on {{chainName}} for {{daysActiveRounded}} days.'
  ),
  FEEDBACK_URI_MODE: z.enum(['auto', 'generated', 'static', 'none']).default('auto'),
  FEEDBACK_EXTRA_JSON: z.preprocess((val) => {
    if (typeof val === 'string') {
      const trimmed = val.trim();
      if (trimmed === '') {
        return {};
      }
      try {
        return JSON.parse(trimmed);
      } catch {
        return val;
      }
    }
    return val ?? {};
  }, z.record(z.any())).default({}),
  // Backward compatibility: FEEDBACK_TAGS (array) kept for any legacy usage but prefer individual tags.
  FEEDBACK_TAGS: z.preprocess((val) => {
    if (typeof val === 'string') {
      try {
        const parsed = JSON.parse(val);
        if (Array.isArray(parsed)) {return parsed;}
        return [parsed];
      } catch {
        return val.split(',').map((t) => t.trim()).filter(Boolean);
      }
    }
    if (Array.isArray(val)) {return val;}
    return [];
  }, z.array(z.string())).default(['pgtcr_active']),
  // Feedback processing tuning
  FEEDBACK_BATCH_INTERVAL_MS: z.coerce.number().int().positive().default(100),
  BATCH_PAUSE_MS: z.coerce.number().int().nonnegative().default(500),
  QUEUE_BATCH_PAUSE_MS: z.coerce.number().int().nonnegative().default(1000),
  // Gas estimation parameters
  GAS_ESTIMATE_FALLBACK: z.coerce.number().int().positive().default(200000),
  GAS_BUFFER_MULTIPLIER: z.coerce.number().int().positive().default(120), // e.g., 120 for 20% buffer
  // Goldsky pagination
  PAGINATION_DELAY_MS: z.coerce.number().int().nonnegative().default(200),
  DRY_RUN: z.preprocess((val) => {
    if (typeof val === 'string') {
      if (val.toLowerCase() === 'true') {return true;}
      if (val.toLowerCase() === 'false') {return false;}
    }
    return val;
  }, z.boolean()).default(false),
  MAX_BATCH_SIZE: z.coerce.number().int().positive().default(10),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  ENABLE_METRICS: z.coerce.boolean().default(false),
  METRICS_PORT: z.coerce.number().int().positive().default(3000),
  DATABASE_PATH: z.string().default('./data/bot-state.db'),
  GOLDSKY_PAGE_SIZE: z.coerce.number().int().positive().default(100),
  GOLDSKY_TIMEOUT_MS: z.coerce.number().int().positive().default(30000),
  MIN_ACTIVE_DAYS: z.coerce.number().int().positive().optional(),
  MIN_AGE_HOURS: z.coerce.number().positive().optional(),
  REVOKE_ON_ABSENCE: z.preprocess((val) => {
    if (typeof val === 'string') {
      if (val.toLowerCase() === 'true') {return true;}
      if (val.toLowerCase() === 'false') {return false;}
    }
    return val;
  }, z.boolean()).default(true),
  ONCHAIN_DUPLICATE_PROTECTION: z.preprocess((val) => {
    if (typeof val === 'string') {
      if (val.toLowerCase() === 'true') {return true;}
      if (val.toLowerCase() === 'false') {return false;}
    }
    return val;
  }, z.boolean()).default(true),
  ONCHAIN_FEEDBACK_SCAN_LIMIT: z.coerce.number().int().positive().default(100),
  // PGTCR instance identifier (default: 1)
  PGTCR_ID: z.coerce.number().int().positive().default(1),
});

// Extended type that includes chain metadata after resolution
export interface ResolvedConfig extends Omit<z.infer<typeof configSchema>, 'GOLDSKY_ENDPOINT' | 'IDENTITY_REGISTRY_ADDRESS' | 'REPUTATION_REGISTRY_ADDRESS' | 'PGTCR_REGISTRY_ADDRESS' | 'CHAIN_ID' | 'CHAIN' | 'CHAINS'> {
  GOLDSKY_ENDPOINT: string;
  IDENTITY_REGISTRY_ADDRESS?: string;
  REPUTATION_REGISTRY_ADDRESS: string;
  PGTCR_REGISTRY_ADDRESS?: string;
  CHAIN_ID: number;
  // Chain selection metadata (optional)
  currentChain?: string;
  // Derived
  MIN_AGE_SECONDS: number;
}

function mergeChainOverrides(
  base: Record<string, any>,
  chainName: string,
  chainsMap: ChainsMap | undefined
): Record<string, any> {
  const merged = { ...base };

  if (chainsMap && chainName && chainsMap[chainName]) {
    const chainCfg = chainsMap[chainName];
    // Merge chain-specific values (override base if present)
    if (chainCfg.GOLDSKY_ENDPOINT !== undefined) {
      merged.GOLDSKY_ENDPOINT = chainCfg.GOLDSKY_ENDPOINT;
    }
    if (chainCfg.IDENTITY_REGISTRY_ADDRESS !== undefined) {
      merged.IDENTITY_REGISTRY_ADDRESS = chainCfg.IDENTITY_REGISTRY_ADDRESS;
    }
    if (chainCfg.REPUTATION_REGISTRY_ADDRESS !== undefined) {
      merged.REPUTATION_REGISTRY_ADDRESS = chainCfg.REPUTATION_REGISTRY_ADDRESS;
    }
    if (chainCfg.PGTCR_REGISTRY_ADDRESS !== undefined) {
      merged.PGTCR_REGISTRY_ADDRESS = chainCfg.PGTCR_REGISTRY_ADDRESS;
    }
    if (chainCfg.CHAIN_ID !== undefined) {
      merged.CHAIN_ID = chainCfg.CHAIN_ID;
    }
    if (chainCfg.PGTCR_ID !== undefined) {
      merged.PGTCR_ID = chainCfg.PGTCR_ID;
    }
  }

  return merged;
}

function resolveChainConfig(raw: z.input<typeof configSchema>): ResolvedConfig {
  const chainName = raw.CHAIN;
  const chainsMap = raw.CHAINS as ChainsMap | undefined;

  // Extract non-chain-specific config
  const {
    CHAIN, CHAINS, // remove these from final config
    GOLDSKY_ENDPOINT,
    IDENTITY_REGISTRY_ADDRESS,
    REPUTATION_REGISTRY_ADDRESS,
    PGTCR_REGISTRY_ADDRESS,
    CHAIN_ID: topLevelChainId,
    ...rest
  } = raw;
  void CHAIN;
  void CHAINS;

  // Start with the chain-agnostic config
  let merged: Record<string, any> = {
    ...rest,
    GOLDSKY_ENDPOINT,
    IDENTITY_REGISTRY_ADDRESS,
    REPUTATION_REGISTRY_ADDRESS,
    PGTCR_REGISTRY_ADDRESS,
    CHAIN_ID: topLevelChainId,
  };

  // Apply chain overrides if CHAIN is specified (via CHAINS JSON)
  if (chainName) {
    merged.currentChain = chainName;
    if (chainsMap && chainsMap[chainName]) {
      merged = mergeChainOverrides(merged, chainName, chainsMap);
    }
  }

  // Apply suffix-based per-chain overrides using the final CHAIN_ID (numeric)
  const activeChainId = merged.CHAIN_ID;
  const numericSuffix = `_${activeChainId}`;
  const env = process.env as Record<string, string | undefined>;

  if (env[`GOLDSKY_ENDPOINT${numericSuffix}`]) {
    merged.GOLDSKY_ENDPOINT = env[`GOLDSKY_ENDPOINT${numericSuffix}`];
  }
  if (env[`REPUTATION_REGISTRY_ADDRESS${numericSuffix}`]) {
    merged.REPUTATION_REGISTRY_ADDRESS = env[`REPUTATION_REGISTRY_ADDRESS${numericSuffix}`];
  }
  if (env[`IDENTITY_REGISTRY_ADDRESS${numericSuffix}`]) {
    merged.IDENTITY_REGISTRY_ADDRESS = env[`IDENTITY_REGISTRY_ADDRESS${numericSuffix}`];
  }
  if (env[`PGTCR_REGISTRY_ADDRESS${numericSuffix}`]) {
    merged.PGTCR_REGISTRY_ADDRESS = env[`PGTCR_REGISTRY_ADDRESS${numericSuffix}`];
  }
  if (env[`DATABASE_PATH${numericSuffix}`]) {
    merged.DATABASE_PATH = env[`DATABASE_PATH${numericSuffix}`];
  }
  if (env[`PGTCR_ID${numericSuffix}`]) {
    merged.PGTCR_ID = parseInt(env[`PGTCR_ID${numericSuffix}`]!, 10);
  }

  // Also apply overrides using chain name (e.g., _SEPOLIA) for backward compatibility with existing .env files
  if (chainName) {
    const nameSuffix = `_${chainName.toUpperCase()}`;
    if (env[`GOLDSKY_ENDPOINT${nameSuffix}`]) {
      merged.GOLDSKY_ENDPOINT = env[`GOLDSKY_ENDPOINT${nameSuffix}`];
    }
    if (env[`REPUTATION_REGISTRY_ADDRESS${nameSuffix}`]) {
      merged.REPUTATION_REGISTRY_ADDRESS = env[`REPUTATION_REGISTRY_ADDRESS${nameSuffix}`];
    }
    if (env[`IDENTITY_REGISTRY_ADDRESS${nameSuffix}`]) {
      merged.IDENTITY_REGISTRY_ADDRESS = env[`IDENTITY_REGISTRY_ADDRESS${nameSuffix}`];
    }
    if (env[`PGTCR_REGISTRY_ADDRESS${nameSuffix}`]) {
      merged.PGTCR_REGISTRY_ADDRESS = env[`PGTCR_REGISTRY_ADDRESS${nameSuffix}`];
    }
    if (env[`PGTCR_ID${nameSuffix}`]) {
      merged.PGTCR_ID = parseInt(env[`PGTCR_ID${nameSuffix}`]!, 10);
    }
    // Also optional per-chain RPC
    if (env[`SEPOLIA_RPC${nameSuffix}`]) {
      merged.SEPOLIA_RPC = env[`SEPOLIA_RPC${nameSuffix}`];
    }
  }

  // Backward compatibility: derive FEEDBACK_TAG1/TAG2 from FEEDBACK_TAGS if not explicitly set
  if (!merged.FEEDBACK_TAG1 || merged.FEEDBACK_TAG1 === '') {
    if (Array.isArray(merged.FEEDBACK_TAGS) && merged.FEEDBACK_TAGS.length > 0) {
      merged.FEEDBACK_TAG1 = merged.FEEDBACK_TAGS[0];
    }
  }
  if (!merged.FEEDBACK_TAG2 || merged.FEEDBACK_TAG2 === '') {
    if (Array.isArray(merged.FEEDBACK_TAGS) && merged.FEEDBACK_TAGS.length > 1) {
      merged.FEEDBACK_TAG2 = merged.FEEDBACK_TAGS[1];
    }
  }

  // Required: endpoint and contract addresses
  const validationSchema = z.object({
    GOLDSKY_ENDPOINT: z.string().url(),
    REPUTATION_REGISTRY_ADDRESS: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
    PGTCR_REGISTRY_ADDRESS: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
    CHAIN_ID: z.number().int().positive(),
  });

  const result = validationSchema.safeParse(merged);
  if (!result.success) {
    const errors = result.error.flatten().fieldErrors;
    const messages = Object.entries(errors)
      .map(([field, msgs]) => `${field}: ${msgs?.join(', ')}`)
      .join('; ');
    throw new Error(`Configuration validation failed: ${messages}`);
  }

  // Compute MIN_AGE_SECONDS from MIN_AGE_HOURS or MIN_ACTIVE_DAYS (no default)
  let minAgeSeconds: number;
  if (merged.MIN_AGE_HOURS !== undefined) {
    minAgeSeconds = merged.MIN_AGE_HOURS * 3600;
  } else if (merged.MIN_ACTIVE_DAYS !== undefined) {
    minAgeSeconds = merged.MIN_ACTIVE_DAYS * 24 * 60 * 60;
  } else {
    throw new Error('Either MIN_AGE_HOURS or MIN_ACTIVE_DAYS must be set to determine age threshold');
  }
  (merged as any).MIN_AGE_SECONDS = minAgeSeconds;

  return merged as ResolvedConfig;
}

function validateConfig(): ResolvedConfig {
  // In test environment, provide safe defaults for required fields to enable unit/integration testing
  const isTest = process.env.NODE_ENV === 'test';
  if (isTest) {
    // Provide placeholder values if not set by the test
    if (!process.env.GOLDSKY_ENDPOINT) {
      process.env.GOLDSKY_ENDPOINT = 'https://test.example.com/graphql';
    }
    if (!process.env.REPUTATION_REGISTRY_ADDRESS) {
      process.env.REPUTATION_REGISTRY_ADDRESS = '0x0000000000000000000000000000000000000000';
    }
    if (!process.env.PGTCR_REGISTRY_ADDRESS) {
      process.env.PGTCR_REGISTRY_ADDRESS = '0x0000000000000000000000000000000000000000';
    }
    // Provide a default test wallet (Hardhat default) if none provided
    if (!process.env.PRIVATE_KEY && !process.env.MNEMONIC) {
      process.env.PRIVATE_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
    }
    // Use in-memory database for tests to avoid file locking and segfaults
    if (!process.env.DATABASE_PATH) {
      process.env.DATABASE_PATH = ':memory:';
    }
    // Set a default chain ID for tests if not provided
    if (!process.env.CHAIN_ID && !process.env.CHAINS) {
      process.env.CHAIN_ID = '1';
    }
    if (!process.env.MIN_AGE_HOURS && !process.env.MIN_ACTIVE_DAYS) {
      process.env.MIN_AGE_HOURS = '72';
    }
  }

  // Build raw env object, including all relevant fields
  const rawEnv: Record<string, any> = {
    NODE_ENV: process.env.NODE_ENV,
    CHAIN: process.env.CHAIN,
    GOLDSKY_ENDPOINT: process.env.GOLDSKY_ENDPOINT,
    IDENTITY_REGISTRY_ADDRESS: process.env.IDENTITY_REGISTRY_ADDRESS,
    REPUTATION_REGISTRY_ADDRESS: process.env.REPUTATION_REGISTRY_ADDRESS,
    PGTCR_REGISTRY_ADDRESS: process.env.PGTCR_REGISTRY_ADDRESS,
    CHAIN_ID: process.env.CHAIN_ID ? parseInt(process.env.CHAIN_ID, 10) : undefined,
    SEPOLIA_RPC: process.env.SEPOLIA_RPC,
    PRIVATE_KEY: process.env.PRIVATE_KEY,
    MNEMONIC: process.env.MNEMONIC,
    FEEDBACK_VALUE: process.env.FEEDBACK_VALUE,
    FEEDBACK_DECIMALS: process.env.FEEDBACK_DECIMALS,
    FEEDBACK_TAG1: process.env.FEEDBACK_TAG1,
    FEEDBACK_TAG2: process.env.FEEDBACK_TAG2,
    FEEDBACK_ENDPOINT: process.env.FEEDBACK_ENDPOINT,
    FEEDBACK_URI: process.env.FEEDBACK_URI,
    FEEDBACK_HASH: process.env.FEEDBACK_HASH,
    FEEDBACK_TITLE_TEMPLATE: process.env.FEEDBACK_TITLE_TEMPLATE,
    FEEDBACK_TEXT_TEMPLATE: process.env.FEEDBACK_TEXT_TEMPLATE,
    FEEDBACK_URI_MODE: process.env.FEEDBACK_URI_MODE,
    FEEDBACK_EXTRA_JSON: process.env.FEEDBACK_EXTRA_JSON,
    FEEDBACK_TAGS: process.env.FEEDBACK_TAGS,
    DRY_RUN: process.env.DRY_RUN,
    MAX_BATCH_SIZE: process.env.MAX_BATCH_SIZE,
    LOG_LEVEL: process.env.LOG_LEVEL,
    ENABLE_METRICS: process.env.ENABLE_METRICS,
    METRICS_PORT: process.env.METRICS_PORT,
    DATABASE_PATH: process.env.DATABASE_PATH,
    GOLDSKY_PAGE_SIZE: process.env.GOLDSKY_PAGE_SIZE,
    GOLDSKY_TIMEOUT_MS: process.env.GOLDSKY_TIMEOUT_MS,
    MIN_ACTIVE_DAYS: process.env.MIN_ACTIVE_DAYS,
    MIN_AGE_HOURS: process.env.MIN_AGE_HOURS,
    REVOKE_ON_ABSENCE: process.env.REVOKE_ON_ABSENCE,
    ONCHAIN_DUPLICATE_PROTECTION: process.env.ONCHAIN_DUPLICATE_PROTECTION,
    ONCHAIN_FEEDBACK_SCAN_LIMIT: process.env.ONCHAIN_FEEDBACK_SCAN_LIMIT,
    PGTCR_ID: process.env.PGTCR_ID,
  };

  // Parse CHAINS from JSON if provided
  if (process.env.CHAINS) {
    try {
      rawEnv.CHAINS = JSON.parse(process.env.CHAINS);
    } catch (e) {
      throw new Error(`Invalid JSON in CHAINS environment variable: ${(e as Error).message}`);
    }
  }

  const parsed = configSchema.safeParse(rawEnv);
  if (!parsed.success) {
    const errors = parsed.error.flatten().fieldErrors;
    const messages = Object.entries(errors)
      .map(([field, msgs]) => `${field}: ${msgs?.join(', ')}`)
      .join('; ');
    throw new Error(`Configuration validation failed: ${messages}`);
  }

  const resolved = resolveChainConfig(parsed.data);

  // Validate wallet credentials
  if (!resolved.PRIVATE_KEY && !resolved.MNEMONIC) {
    throw new Error('Either PRIVATE_KEY or MNEMONIC must be provided');
  }

  // Normalize PRIVATE_KEY to include 0x prefix if missing
  if (resolved.PRIVATE_KEY && !resolved.PRIVATE_KEY.startsWith('0x')) {
    resolved.PRIVATE_KEY = '0x' + resolved.PRIVATE_KEY;
  }

  // Ensure absolute path for database unless using in-memory SQLite
  if (resolved.DATABASE_PATH !== ':memory:' && !path.isAbsolute(resolved.DATABASE_PATH)) {
    resolved.DATABASE_PATH = path.resolve(process.cwd(), resolved.DATABASE_PATH);
  }

  return resolved;
}

// Singleton config instance
let cachedConfig: ResolvedConfig | null = null;

export function getConfig(): ResolvedConfig {
  if (!cachedConfig) {
    cachedConfig = validateConfig();
  }
  return cachedConfig;
}

export function resetConfig(): void {
  cachedConfig = null;
}
