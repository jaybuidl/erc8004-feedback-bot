# Agent Registration Transaction (ERC-8004)

This document describes how to register an Ethereum address as an ERC-8004 agent on Sepolia.

## When to Register

- Optional for the bot wallet. The bot can send feedback without being registered.
- Useful for identity, reputation tracking, or if you want the bot to also receive feedback from other curators.
- May be required in future governance or access control mechanisms.

## Prerequisites

- A Sepolia wallet with a private key (the bot's wallet or another).
- The wallet must have some Sepolia ETH for gas.
- The **ERC-8004 Identity Registry** contract must be deployed on Sepolia.
- You know the `IDENTITY_REGISTRY_ADDRESS`.
- You have an RPC endpoint for Sepolia (`SEPOLIA_RPC`) that can send transactions.

## Transaction Details

The registration transaction calls the `register()` function on the `IdentityRegistry` contract.

**Contract**: `IIdentityRegistry` (ERC-8004 standard)  
**Method**: `register()`  
**Parameters**: none  
**Returns**: `uint256 agentId` – the token ID representing the new agent identity.

The transaction mints an ERC-721 token to the caller, mapping the address to an `agentId`.

### Example
```typescript
const tx = await identityRegistry.register();
const receipt = await tx.wait();
```

## Using the Provided Script

A ready-to-use script is included: `scripts/mint-identity.ts`.

### Environment Variables

Set these in `.env` (or pass directly):

- `PRIVATE_KEY` or `BOT_PRIVATE_KEY`: private key of the registering wallet.
- `IDENTITY_REGISTRY_ADDRESS`: address of the deployed Identity Registry on Sepolia.
- `SEPOLIA_RPC` or `SEPOLIA_RPC_URL`: RPC endpoint (e.g., `https://sepolia.g.alchemy.com/v2/your-key`).

### Run

```bash
npx ts-node scripts/mint-identity.ts
```

The script:
1. Creates a wallet from the private key.
2. Connects to the RPC provider.
3. Calls `register()` on the Identity Registry.
4. Waits for confirmation (1 block).
5. Extracts the `agentId` from the `Transfer` event logs.
6. Prints the agentId and verification details.

### Sample Output

```
Bot Wallet Address: 0xYourWalletAddress
Registering as an ERC-8004 agent...
Transaction sent, hash: 0xabc123...
Waiting for confirmation...
✅ Agent registration successful!
Agent ID (tokenId): 1
Verification:
- Owner: 0xYourWalletAddress
- TokenURI: https://...
```

## After Registration

- Record the `agentId`. You may need it for future interactions with the reputation registry or other ERC-8004 contracts.
- The registration transaction is permanent; the agentId cannot be transferred unless the token is transferred.
- To verify on-chain, you can call `identityRegistry.agentId(yourAddress)` which should return the same tokenId.

## Troubleshooting

- **"insufficient funds"**: Wallet lacks Sepolia ETH for gas. Fund via a faucet.
- **"call revert"**: Ensure the `IdentityRegistry` address is correct and the contract is deployed on Sepolia. Check that you are calling the correct network.
- **Private key invalid**: Private key must be 64 hex characters (`0x` optional). No extra whitespace.
- **RPC errors**: Check `SEPOLIA_RPC` connectivity. Some RPC providers have rate limits; switch if needed.

## References

- ERC-8004 Standard: https://eips.ethereum.org/EIPS/eip-8004
- Identity Registry Interface: `function register() external returns (uint256 agentId);`
- This script uses ethers v6.
