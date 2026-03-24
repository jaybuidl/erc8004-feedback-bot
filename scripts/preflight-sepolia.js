#!/usr/bin/env node

require('dotenv').config();

const { ethers } = require('ethers');

const SEPOLIA_CHAIN_ID = '11155111';
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

function pickEnv(name) {
  return process.env[`${name}_${SEPOLIA_CHAIN_ID}`] || process.env[name] || '';
}

function parseBool(value, fallback) {
  if (value === undefined || value === '') {
    return fallback;
  }
  return String(value).toLowerCase() === 'true';
}

function getWallet() {
  if (process.env.PRIVATE_KEY) {
    const privateKey = process.env.PRIVATE_KEY.startsWith('0x')
      ? process.env.PRIVATE_KEY
      : `0x${process.env.PRIVATE_KEY}`;
    return new ethers.Wallet(privateKey);
  }

  if (process.env.MNEMONIC) {
    return ethers.Wallet.fromPhrase(process.env.MNEMONIC);
  }

  throw new Error('Missing PRIVATE_KEY or MNEMONIC');
}

async function queryGoldsky(endpoint, registryAddress) {
  const body = {
    query: `
      query PreflightItems($where: Item_filter!) {
        items(
          first: 1
          where: $where
          orderBy: includedAt
          orderDirection: desc
        ) {
          id
          includedAt
          status
          stake
          metadata {
            key0
            key2
          }
        }
      }
    `,
    variables: {
      where: {
        status_in: ['Submitted', 'Reincluded'],
        stake_gt: '0',
        ...(registryAddress ? { registryAddress } : {}),
      },
    },
  };

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    throw new Error(`Goldsky returned HTTP ${response.status}`);
  }

  const payload = await response.json();
  if (payload.errors?.length) {
    throw new Error(payload.errors.map((entry) => entry.message).join('; '));
  }

  return payload.data?.items ?? [];
}

async function main() {
  console.log('== Sepolia preflight ==');

  const goldskyEndpoint = pickEnv('GOLDSKY_ENDPOINT');
  const pgtcrRegistryAddress = pickEnv('PGTCR_REGISTRY_ADDRESS');
  const reputationRegistryAddress = pickEnv('REPUTATION_REGISTRY_ADDRESS');
  const rpcUrl = process.env.SEPOLIA_RPC || '';
  const dryRun = parseBool(process.env.DRY_RUN, false);
  const revokeOnAbsence = parseBool(process.env.REVOKE_ON_ABSENCE, true);
  const duplicateProtection = parseBool(process.env.ONCHAIN_DUPLICATE_PROTECTION, true);
  const threshold = process.env.MIN_AGE_HOURS
    ? `${process.env.MIN_AGE_HOURS} hour(s)`
    : `${process.env.MIN_ACTIVE_DAYS || '3'} day(s)`;

  const missing = [];
  if (!goldskyEndpoint) {missing.push('GOLDSKY_ENDPOINT or GOLDSKY_ENDPOINT_11155111');}
  if (!pgtcrRegistryAddress) {missing.push('PGTCR_REGISTRY_ADDRESS or PGTCR_REGISTRY_ADDRESS_11155111');}
  if (!reputationRegistryAddress) {missing.push('REPUTATION_REGISTRY_ADDRESS or REPUTATION_REGISTRY_ADDRESS_11155111');}
  if (!rpcUrl) {missing.push('SEPOLIA_RPC');}
  if (!process.env.PRIVATE_KEY && !process.env.MNEMONIC) {missing.push('PRIVATE_KEY or MNEMONIC');}

  if (missing.length > 0) {
    throw new Error(`Missing required env: ${missing.join(', ')}`);
  }

  const wallet = getWallet();
  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const balance = await provider.getBalance(wallet.address);
  const balanceEth = ethers.formatEther(balance);

  console.log(`wallet: ${wallet.address}`);
  console.log(`balance: ${balanceEth} ETH`);
  console.log(`threshold: ${threshold}`);
  console.log(`dry-run: ${dryRun}`);
  console.log(`revoke-on-absence: ${revokeOnAbsence}`);
  console.log(`on-chain-duplicate-protection: ${duplicateProtection}`);
  console.log(`database: ${pickEnv('DATABASE_PATH') || './data/bot-state.db'}`);

  if (!ethers.isAddress(pgtcrRegistryAddress) || pgtcrRegistryAddress === ZERO_ADDRESS) {
    throw new Error('PGTCR registry address is invalid');
  }

  if (!ethers.isAddress(reputationRegistryAddress) || reputationRegistryAddress === ZERO_ADDRESS) {
    throw new Error('Reputation registry address is invalid');
  }

  console.log('goldsky: probing endpoint...');
  const items = await queryGoldsky(goldskyEndpoint, pgtcrRegistryAddress);
  console.log(`goldsky: ok (${items.length} sample active item(s) returned)`);

  if (balance === 0n) {
    throw new Error('Wallet has zero Sepolia ETH');
  }

  console.log('preflight: ok');
}

main().catch((error) => {
  console.error(`preflight: failed - ${error.message}`);
  process.exit(1);
});
