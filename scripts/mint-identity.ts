import { ethers } from 'ethers';

// Configuration
const PRIVATE_KEY = process.env.BOT_PRIVATE_KEY || process.env.PRIVATE_KEY!;
const IDENTITY_REGISTRY_ADDRESS = process.env.IDENTITY_REGISTRY_ADDRESS || '0x8004A818BFB912233c491871b3d84c89A494BD9e';
// Use SEPOLIA_RPC if set, else SEPOLIA_RPC_URL, else default demo (replace demo with your own RPC)
const SEPOLIA_RPC_URL = process.env.SEPOLIA_RPC || process.env.SEPOLIA_RPC_URL || 'https://sepolia.g.alchemy.com/v2/demo';

// Minimal ABI for IdentityRegistry
const ABI = [
  'function register() returns (uint256 agentId)',
  'function tokenURI(uint256 tokenId) view returns (string)',
  'function ownerOf(uint256 tokenId) view returns (address)',
  'function totalSupply() view returns (uint256)'
];

async function main() {
  if (!PRIVATE_KEY) {
    console.error('Error: BOT_PRIVATE_KEY environment variable not set.');
    process.exit(1);
  }

  // Setup provider and wallet
  const provider = new ethers.JsonRpcProvider(SEPOLIA_RPC_URL);
  const wallet = new ethers.Wallet(PRIVATE_KEY, provider);

  console.log('Bot Wallet Address:', wallet.address);
  console.log('Registering as an ERC-8004 agent...');

  // Connect to IdentityRegistry
  const identityRegistry = new ethers.Contract(IDENTITY_REGISTRY_ADDRESS, ABI, wallet);

  try {
    // Mint the identity (call register)
    const tx = await identityRegistry.register();
    console.log('Transaction sent, hash:', tx.hash);
    console.log('Waiting for confirmation...');
    const receipt = await tx.wait();

    // The event should emit AgentRegistered or Transfer (ERC721). We inspect logs to extract tokenId.
    // ERC-721 Transfer event signature: Transfer(address,address,uint256)
    // When a new token is minted, from is address(0), to is the wallet.
    const iface = new ethers.Interface([
      'event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)'
    ]);
    const tokenId = receipt.logs
      .map(log => {
        try {
          const parsed = iface.parseLog(log);
          if (parsed && parsed.name === 'Transfer' && parsed.args.to.toLowerCase() === wallet.address.toLowerCase()) {
            return parsed.args.tokenId.toString();
          }
        } catch (e) {}
        return null;
      })
      .filter(id => id !== null)[0];

    if (tokenId) {
      console.log('✅ Agent registration successful!');
      console.log('Agent ID (tokenId):', tokenId);

      // Verification: check ownerOf and tokenURI
      const owner = await identityRegistry.ownerOf(tokenId);
      const tokenURI = await identityRegistry.tokenURI(tokenId);
      console.log('Verification:');
      console.log('- Owner:', owner);
      console.log('- TokenURI:', tokenURI);
    } else {
      console.log('Transaction mined, but could not find tokenId from logs. Check manually on the contract.');
      console.log('You can query the contract: agentId(address) returns the tokenId for an address.');
      // Fallback: query agentId(address)
      try {
        const agentId = await identityRegistry.agentId(wallet.address);
        console.log('Agent ID (via agentId()):', agentId.toString());
      } catch (e) {
        console.error('Could not query agentId:', e);
      }
    }
  } catch (error) {
    console.error('❌ Failed to register agent:', error);
    process.exit(1);
  }
}

main().catch(console.error);
