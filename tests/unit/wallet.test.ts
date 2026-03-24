import { Wallet } from 'ethers';
import logger from '../../src/logger';
import { resetConfig } from '../../src/config';
import { WalletManager } from '../../src/wallet';

describe('WalletManager', () => {
  const validPrivateKey = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
  const validMnemonic = 'test test test test test test test test test test test junk';

  beforeEach(() => {
    resetConfig();
    delete process.env.MNEMONIC;
    delete process.env.SEPOLIA_RPC;
    process.env.NODE_ENV = 'test';
    process.env.PRIVATE_KEY = validPrivateKey;
  });

  afterEach(() => {
    jest.restoreAllMocks();
    resetConfig();
    delete process.env.PRIVATE_KEY;
    delete process.env.MNEMONIC;
    delete process.env.SEPOLIA_RPC;
    delete process.env.GOLDSKY_ENDPOINT;
    delete process.env.REPUTATION_REGISTRY_ADDRESS;
    delete process.env.PGTCR_REGISTRY_ADDRESS;
    delete process.env.MIN_AGE_HOURS;
  });

  describe('init with PRIVATE_KEY', () => {
    it('should load wallet from private key', async () => {
      const manager = new WalletManager();

      await manager.init();
      const signer = manager.getSigner();

      expect(signer).toBeInstanceOf(Wallet);
      expect(manager.getAddress()).toMatch(/^0x[a-fA-F0-9]{40}$/);
    });

    it('should add 0x prefix if missing', async () => {
      const manager = new WalletManager();

      await manager.init();
      const signer = manager.getSigner();

      expect(signer.address).toBeDefined();
    });

    it('should log wallet address on init', async () => {
      const infoMock = jest.spyOn(logger, 'info').mockImplementation(() => logger);
      const warnMock = jest.spyOn(logger, 'warn').mockImplementation(() => logger);
      const manager = new WalletManager();

      await manager.init();

      expect(infoMock).toHaveBeenCalledWith(
        'Wallet loaded from PRIVATE_KEY',
        expect.objectContaining({ address: expect.any(String) })
      );
      expect(warnMock).toHaveBeenCalledWith(
        'SEPOLIA_RPC not set; wallet will have no provider. Transactions will fail.'
      );
    });
  });

  describe('init with MNEMONIC', () => {
    it('should load wallet from mnemonic', async () => {
      delete process.env.PRIVATE_KEY;
      process.env.MNEMONIC = validMnemonic;
      resetConfig();
      const manager = new WalletManager();

      await manager.init();
      const address = manager.getAddress();

      expect(address).toBeDefined();
      expect(address).toMatch(/^0x[a-fA-F0-9]{40}$/);
    });
  });

  describe('init errors', () => {
    it('should throw if no credentials provided', async () => {
      process.env.NODE_ENV = 'production';
      process.env.GOLDSKY_ENDPOINT = 'https://test.example.com/graphql';
      process.env.REPUTATION_REGISTRY_ADDRESS = '0x1111111111111111111111111111111111111111';
      process.env.PGTCR_REGISTRY_ADDRESS = '0x2222222222222222222222222222222222222222';
      process.env.MIN_AGE_HOURS = '72';
      delete process.env.PRIVATE_KEY;
      delete process.env.MNEMONIC;
      resetConfig();
      const manager = new WalletManager();

      await expect(manager.init()).rejects.toThrow('Either PRIVATE_KEY or MNEMONIC must be provided');
    });

    it('should throw if invalid private key', async () => {
      process.env.PRIVATE_KEY = 'invalid';
      delete process.env.MNEMONIC;
      resetConfig();
      const manager = new WalletManager();

      await expect(manager.init()).rejects.toThrow();
    });
  });

  describe('getSigner before init', () => {
    it('should throw error', () => {
      const manager = new WalletManager();

      expect(() => manager.getSigner()).toThrow('WalletManager not initialized. Call init() first.');
    });
  });

  describe('idempotency', () => {
    it('should not reinitialize if already initialized', async () => {
      const manager = new WalletManager();

      await manager.init();
      const signer1 = manager.getSigner();
      await manager.init();
      const signer2 = manager.getSigner();

      expect(signer1).toBe(signer2);
    });
  });
});
