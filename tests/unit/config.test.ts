import { getConfig, resetConfig } from '../../src/config';
import path from 'path';

function setEnv(overrides: Record<string, string | undefined>) {
  // Ensure DRY_RUN is not set from .env unless explicitly overridden, so default (false) applies
  if (overrides.DRY_RUN === undefined) {
    delete process.env.DRY_RUN;
  }
  if (overrides.LOG_LEVEL === undefined) {
    delete process.env.LOG_LEVEL;
  }
  const defaults = {
    NODE_ENV: 'test',
    GOLDSKY_ENDPOINT: 'https://test.graphql',
    IDENTITY_REGISTRY_ADDRESS: '0x1111111111111111111111111111111111111111',
    REPUTATION_REGISTRY_ADDRESS: '0x2222222222222222222222222222222222222222',
    MIN_AGE_HOURS: '24', // default age threshold for tests (1 day)
  };
  for (const [k, v] of Object.entries({ ...defaults, ...overrides })) {
    if (v === undefined) {
      delete process.env[k];
    } else {
      process.env[k] = v;
    }
  }
  resetConfig();
}

describe('config', () => {
  beforeEach(() => {
    resetConfig();
    setEnv({});
  });

  afterEach(() => {
    resetConfig();
    // Clean up any lingering credentials to avoid cross-test contamination
    delete process.env.PRIVATE_KEY;
    delete process.env.MNEMONIC;
  });

  it('should load default values', () => {
    const cfg = getConfig();
    expect(cfg.NODE_ENV).toBe('test');
    expect(cfg.FEEDBACK_VALUE).toBe(1);
    expect(cfg.DRY_RUN).toBe(false);
    expect(cfg.MAX_BATCH_SIZE).toBe(10);
    expect(cfg.LOG_LEVEL).toBe('info');
  });

  it('should require valid addresses', () => {
    setEnv({ IDENTITY_REGISTRY_ADDRESS: 'invalid' });
    expect(() => getConfig()).toThrow('Configuration validation failed');
  });

  it('should accept private key with or without 0x', () => {
    setEnv({ PRIVATE_KEY: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef' });
    const cfg = getConfig();
    expect(cfg.PRIVATE_KEY).toMatch(/^0x/);
  });

  it('should parse FEEDBACK_TAGS as JSON array', () => {
    setEnv({ FEEDBACK_TAGS: '["tag1", "tag2"]' });
    const cfg = getConfig();
    expect(cfg.FEEDBACK_TAGS).toEqual(['tag1', 'tag2']);
  });

  it('should parse FEEDBACK_TAGS as comma-separated fallback', () => {
    setEnv({ FEEDBACK_TAGS: 'tag1,tag2' });
    const cfg = getConfig();
    expect(cfg.FEEDBACK_TAGS).toEqual(['tag1', 'tag2']);
  });

  it('should throw if neither PRIVATE_KEY nor MNEMONIC provided', () => {
    // Run in production mode to avoid test environment auto-provisioning
    setEnv({ NODE_ENV: 'production', PRIVATE_KEY: undefined, MNEMONIC: undefined });
    expect(() => getConfig()).toThrow('Either PRIVATE_KEY or MNEMONIC must be provided');
  });

  it('should set absolute database path', () => {
    setEnv({ DATABASE_PATH: './data/test.db' });
    const cfg = getConfig();
    expect(cfg.DATABASE_PATH).toContain('data/test.db');
    expect(path.isAbsolute(cfg.DATABASE_PATH)).toBe(true);
  });

  it('should accept decimal MIN_AGE_HOURS values', () => {
    setEnv({ MIN_AGE_HOURS: '0.5' });
    const cfg = getConfig();
    expect(cfg.MIN_AGE_HOURS).toBe(0.5);
    expect(cfg.MIN_AGE_SECONDS).toBe(1800);
  });

  describe('multi-chain support', () => {
    beforeEach(() => {
      resetConfig();
      // Clear CHAINS and CHAIN by default
      delete process.env.CHAINS;
      delete process.env.CHAIN;
    });

    it('should use top-level values when CHAIN is not set (legacy mode)', () => {
      setEnv({
        GOLDSKY_ENDPOINT: 'https://legacy.example.com/graphql',
        REPUTATION_REGISTRY_ADDRESS: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        CHAIN_ID: '1',
      });
      const cfg = getConfig();
      expect(cfg.GOLDSKY_ENDPOINT).toBe('https://legacy.example.com/graphql');
      expect(cfg.REPUTATION_REGISTRY_ADDRESS).toBe('0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
      expect(cfg.CHAIN_ID).toBe(1);
      expect(cfg.currentChain).toBeUndefined();
    });

    it('should merge chain-specific overrides when CHAIN is set and CHAINS defined', () => {
      const chains = {
        sepolia: {
          GOLDSKY_ENDPOINT: 'https://sepolia.example.com/graphql',
          IDENTITY_REGISTRY_ADDRESS: '0x1111111111111111111111111111111111111111',
          REPUTATION_REGISTRY_ADDRESS: '0x2222222222222222222222222222222222222222',
          CHAIN_ID: 11155111,
        },
        mainnet: {
          GOLDSKY_ENDPOINT: 'https://mainnet.example.com/graphql',
          REPUTATION_REGISTRY_ADDRESS: '0x3333333333333333333333333333333333333333',
          CHAIN_ID: 1,
        },
      };
      setEnv({
        CHAINS: JSON.stringify(chains),
        CHAIN: 'sepolia',
        // Top-level values can be different; they act as fallback if chain doesn't define them
        GOLDSKY_ENDPOINT: 'https://fallback.example.com/graphql',
        REPUTATION_REGISTRY_ADDRESS: '0x0000000000000000000000000000000000000000',
        CHAIN_ID: '1',
      });
      const cfg = getConfig();
      // Should use chain-specific values for those defined in chain config
      expect(cfg.GOLDSKY_ENDPOINT).toBe('https://sepolia.example.com/graphql');
      expect(cfg.REPUTATION_REGISTRY_ADDRESS).toBe('0x2222222222222222222222222222222222222222');
      expect(cfg.CHAIN_ID).toBe(11155111);
      expect(cfg.IDENTITY_REGISTRY_ADDRESS).toBe('0x1111111111111111111111111111111111111111');
      expect(cfg.currentChain).toBe('sepolia');
    });

    it('should fallback to top-level values when CHAIN is set but chain config missing', () => {
      // Only define mainnet in CHAINS, but CHAIN=sepolia -> sepolia not in CHAINS, fallback to top-level
      const chains = {
        mainnet: {
          GOLDSKY_ENDPOINT: 'https://mainnet.example.com/graphql',
          REPUTATION_REGISTRY_ADDRESS: '0x3333333333333333333333333333333333333333',
          CHAIN_ID: 1,
        },
      };
      setEnv({
        CHAINS: JSON.stringify(chains),
        CHAIN: 'sepolia',
        GOLDSKY_ENDPOINT: 'https://top.example.com/graphql',
        REPUTATION_REGISTRY_ADDRESS: '0x4444444444444444444444444444444444444444',
        CHAIN_ID: '2',
      });
      const cfg = getConfig();
      // Since sepolia not in CHAINS, use top-level values
      expect(cfg.GOLDSKY_ENDPOINT).toBe('https://top.example.com/graphql');
      expect(cfg.REPUTATION_REGISTRY_ADDRESS).toBe('0x4444444444444444444444444444444444444444');
      expect(cfg.CHAIN_ID).toBe(2);
      expect(cfg.currentChain).toBe('sepolia');
    });

    it('should allow partial overrides: chain config overrides only specified fields', () => {
      const chains = {
        sepolia: {
          // Only override endpoint, leave others to fallback to top-level
          GOLDSKY_ENDPOINT: 'https://sepolia-override.example.com/graphql',
          CHAIN_ID: 11155111,
        },
      };
      setEnv({
        CHAINS: JSON.stringify(chains),
        CHAIN: 'sepolia',
        GOLDSKY_ENDPOINT: 'https://top.example.com/graphql',
        IDENTITY_REGISTRY_ADDRESS: '0x1111111111111111111111111111111111111111',
        REPUTATION_REGISTRY_ADDRESS: '0x2222222222222222222222222222222222222222',
        CHAIN_ID: '1',
      });
      const cfg = getConfig();
      expect(cfg.GOLDSKY_ENDPOINT).toBe('https://sepolia-override.example.com/graphql'); // overridden
      expect(cfg.REPUTATION_REGISTRY_ADDRESS).toBe('0x2222222222222222222222222222222222222222'); // top-level used
      expect(cfg.IDENTITY_REGISTRY_ADDRESS).toBe('0x1111111111111111111111111111111111111111'); // top-level used
      expect(cfg.CHAIN_ID).toBe(11155111); // overridden
    });

    it('should throw if required fields missing after merging', () => {
      const chains = {
        sepolia: {
          // Missing REPUTATION_REGISTRY_ADDRESS and CHAIN_ID (though CHAIN_ID now defaults)
          GOLDSKY_ENDPOINT: 'https://sepolia.example.com/graphql',
        },
      };
      setEnv({
        NODE_ENV: 'production', // avoid test auto-provisioning of required fields
        CHAINS: JSON.stringify(chains),
        CHAIN: 'sepolia',
        // No top-level REPUTATION_REGISTRY_ADDRESS or CHAIN_ID
        REPUTATION_REGISTRY_ADDRESS: undefined,
        CHAIN_ID: undefined,
        // Provide wallet and GOLDSKY to pass other validations, so we only test REPUTATION missing
        GOLDSKY_ENDPOINT: 'https://example.com/graphql',
        PRIVATE_KEY: '0x' + 'a'.repeat(64),
      });
      expect(() => getConfig()).toThrow('Configuration validation failed');
    });

    it('should parse CHAINS from JSON env var correctly', () => {
      const chains = {
        mainnet: {
          GOLDSKY_ENDPOINT: 'https://mainnet.example.com/graphql',
          REPUTATION_REGISTRY_ADDRESS: '0x9999999999999999999999999999999999999999',
          CHAIN_ID: 1,
        },
      };
      setEnv({
        CHAINS: JSON.stringify(chains),
        CHAIN: 'mainnet',
      });
      const cfg = getConfig();
      expect(cfg.GOLDSKY_ENDPOINT).toBe('https://mainnet.example.com/graphql');
      expect(cfg.REPUTATION_REGISTRY_ADDRESS).toBe('0x9999999999999999999999999999999999999999');
      expect(cfg.CHAIN_ID).toBe(1);
    });

    // ===========================
    // New suffix-based overrides (simple multi-chain)
    // ===========================
    it('should apply suffix-based overrides for chain-specific config', () => {
      // Base values
      setEnv({
        GOLDSKY_ENDPOINT: 'https://base.example.com/graphql',
        REPUTATION_REGISTRY_ADDRESS: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        IDENTITY_REGISTRY_ADDRESS: '0xcccccccccccccccccccccccccccccccccccccccc',
        CHAIN_ID: '11155111', // Sepolia
        // Suffix overrides
        GOLDSKY_ENDPOINT_11155111: 'https://sepolia-suffix.example.com/graphql',
        REPUTATION_REGISTRY_ADDRESS_11155111: '0x1111111111111111111111111111111111111111',
      });
      const cfg = getConfig();
      expect(cfg.CHAIN_ID).toBe(11155111);
      expect(cfg.GOLDSKY_ENDPOINT).toBe('https://sepolia-suffix.example.com/graphql');
      expect(cfg.REPUTATION_REGISTRY_ADDRESS).toBe('0x1111111111111111111111111111111111111111');
      // IDENTITY_REGISTRY_ADDRESS has no suffix override, should use base
      expect(cfg.IDENTITY_REGISTRY_ADDRESS).toBe('0xcccccccccccccccccccccccccccccccccccccccc');
    });

    it('should fallback to base values when no suffix override present', () => {
      setEnv({
        GOLDSKY_ENDPOINT: 'https://base.example.com/graphql',
        REPUTATION_REGISTRY_ADDRESS: '0x2222222222222222222222222222222222222222',
        CHAIN_ID: '1', // mainnet, no suffix overrides
      });
      const cfg = getConfig();
      expect(cfg.CHAIN_ID).toBe(1);
      expect(cfg.GOLDSKY_ENDPOINT).toBe('https://base.example.com/graphql');
      expect(cfg.REPUTATION_REGISTRY_ADDRESS).toBe('0x2222222222222222222222222222222222222222');
    });

    it('should allow suffix overrides to take precedence over CHAINS config', () => {
      // Both CHAINS and suffix override for same chain ID
      const chains = {
        sepolia: {
          GOLDSKY_ENDPOINT: 'https://sepolia-chains.example.com/graphql',
          REPUTATION_REGISTRY_ADDRESS: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          CHAIN_ID: 11155111,
        },
      };
      setEnv({
        CHAINS: JSON.stringify(chains),
        CHAIN: 'sepolia',
        CHAIN_ID: '11155111',
        GOLDSKY_ENDPOINT: 'https://top.example.com/graphql',
        REPUTATION_REGISTRY_ADDRESS: '0x0000000000000000000000000000000000000000',
        // Suffix overrides
        GOLDSKY_ENDPOINT_11155111: 'https://sepolia-suffix.example.com/graphql',
        REPUTATION_REGISTRY_ADDRESS_11155111: '0x1111111111111111111111111111111111111111',
      });
      const cfg = getConfig();
      // Suffix overrides should win after CHAINS merging
      expect(cfg.GOLDSKY_ENDPOINT).toBe('https://sepolia-suffix.example.com/graphql');
      expect(cfg.REPUTATION_REGISTRY_ADDRESS).toBe('0x1111111111111111111111111111111111111111');
      expect(cfg.CHAIN_ID).toBe(11155111);
    });

    it('should default CHAIN_ID to 11155111 in production mode when not set', () => {
      setEnv({
        NODE_ENV: 'production',
        CHAIN_ID: undefined,
        GOLDSKY_ENDPOINT: 'https://example.com/graphql',
        REPUTATION_REGISTRY_ADDRESS: '0x2222222222222222222222222222222222222222',
        PRIVATE_KEY: '0x' + 'a'.repeat(64),
      });
      const cfg = getConfig();
      expect(cfg.CHAIN_ID).toBe(11155111);
    });

    it('should default CHAIN_ID to 1 in test mode when not set', () => {
      // NODE_ENV=test by default in setEnv
      setEnv({
        CHAIN_ID: undefined,
        GOLDSKY_ENDPOINT: 'https://base.example.com/graphql',
        REPUTATION_REGISTRY_ADDRESS: '0x2222222222222222222222222222222222222222',
      });
      const cfg = getConfig();
      expect(cfg.CHAIN_ID).toBe(1);
    });

    it('should support only partial suffix overrides (some fields use base)', () => {
      setEnv({
        GOLDSKY_ENDPOINT: 'https://base.example.com/graphql',
        REPUTATION_REGISTRY_ADDRESS: '0x2222222222222222222222222222222222222222',
        IDENTITY_REGISTRY_ADDRESS: '0x1111111111111111111111111111111111111111',
        CHAIN_ID: '11155111',
        GOLDSKY_ENDPOINT_11155111: 'https://sepolia-suffix.example.com/graphql',
        // Ensure no suffix overrides for REPUTATION or IDENTITY from previous tests
        REPUTATION_REGISTRY_ADDRESS_11155111: undefined,
        IDENTITY_REGISTRY_ADDRESS_11155111: undefined,
      });
      const cfg = getConfig();
      expect(cfg.GOLDSKY_ENDPOINT).toBe('https://sepolia-suffix.example.com/graphql');
      expect(cfg.REPUTATION_REGISTRY_ADDRESS).toBe('0x2222222222222222222222222222222222222222'); // base
      expect(cfg.IDENTITY_REGISTRY_ADDRESS).toBe('0x1111111111111111111111111111111111111111'); // base
    });

    it('should apply suffix override for PGTCR_REGISTRY_ADDRESS', () => {
      setEnv({
        GOLDSKY_ENDPOINT: 'https://base.example.com/graphql',
        REPUTATION_REGISTRY_ADDRESS: '0x2222222222222222222222222222222222222222',
        CHAIN_ID: '11155111',
        PGTCR_REGISTRY_ADDRESS: '0x0000000000000000000000000000000000000000',
        PGTCR_REGISTRY_ADDRESS_11155111: '0x3333333333333333333333333333333333333333',
      });
      const cfg = getConfig();
      expect(cfg.PGTCR_REGISTRY_ADDRESS).toBe('0x3333333333333333333333333333333333333333');
    });

    it('should apply suffix override for DATABASE_PATH', () => {
      setEnv({
        DATABASE_PATH: './data/base.db',
        CHAIN_ID: '11155111',
        DATABASE_PATH_11155111: './data/sepolia.db',
      });
      const cfg = getConfig();
      // The config should resolve to absolute path (unless using :memory:)
      const expectedPath = path.resolve(process.cwd(), './data/sepolia.db');
      expect(cfg.DATABASE_PATH).toBe(expectedPath);
    });
  });
});
