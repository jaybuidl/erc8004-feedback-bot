import { Wallet, JsonRpcProvider } from 'ethers';
import { getConfig } from './config';
import logger from './logger';

export class WalletManager {
  private wallet: Wallet | null = null;
  private initialized = false;

  async init(): Promise<void> {
    if (this.initialized) {return;}

    const config = getConfig(); // Load config at init time for testability

    try {
      if (config.PRIVATE_KEY) {
        const pk = config.PRIVATE_KEY.startsWith('0x')
          ? config.PRIVATE_KEY
          : `0x${config.PRIVATE_KEY}`;
        this.wallet = new Wallet(pk);
        logger.info('Wallet loaded from PRIVATE_KEY', {
          address: this.wallet.address,
        });
      } else if (config.MNEMONIC) {
        const hdNode = Wallet.fromPhrase(config.MNEMONIC) as unknown as Wallet;
        this.wallet = hdNode;
        logger.info('Wallet loaded from MNEMONIC', {
          address: this.wallet.address,
        });
      } else {
        throw new Error('No wallet credentials configured');
      }

      // Attach provider if SEPOLIA_RPC is configured (required for sending transactions and contract calls)
      if (config.SEPOLIA_RPC) {
        const provider = new JsonRpcProvider(config.SEPOLIA_RPC);
        this.wallet = this.wallet.connect(provider);
        logger.info('Wallet connected to provider', { rpc: config.SEPOLIA_RPC });
      } else {
        logger.warn('SEPOLIA_RPC not set; wallet will have no provider. Transactions will fail.');
      }

      this.initialized = true;
    } catch (error) {
      logger.error('Failed to initialize wallet', error as Error);
      throw error;
    }
  }

  getSigner(): Wallet {
    if (!this.initialized || !this.wallet) {
      throw new Error('WalletManager not initialized. Call init() first.');
    }
    return this.wallet;
  }

  getAddress(): string {
    if (!this.initialized || !this.wallet) {
      throw new Error('WalletManager not initialized. Call init() first.');
    }
    return this.wallet.address;
  }
}

export const walletManager = new WalletManager();
export type WalletManagerType = WalletManager;
