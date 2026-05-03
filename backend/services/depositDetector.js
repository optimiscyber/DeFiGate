import { Connection, PublicKey } from '@solana/web3.js';
import { sequelize, User, Account, Transaction, LedgerEntry, Wallet } from '../models/index.js';

const SOLANA_RPC_URL = process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';
const USDC_MINT = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
const USDC_MINT_ADDRESS = USDC_MINT.toBase58();
const SYSTEM_USER_EMAIL = process.env.SYSTEM_USER_EMAIL || 'system@defigate.internal';
const SYSTEM_USER_NAME = 'DeFiGate External Reserve';
const POLL_INTERVAL_MS = 10000;

const connection = new Connection(SOLANA_RPC_URL, 'confirmed');
const processedSignatures = new Set();

function parseTokenAmount(tokenBalance) {
  if (!tokenBalance || !tokenBalance.uiTokenAmount) return 0n;
  const amountString = String(tokenBalance.uiTokenAmount.amount || '0');
  try {
    return BigInt(amountString);
  } catch {
    return 0n;
  }
}

function formatUsdcAmount(amountBaseUnits) {
  const units = 1000000n;
  const whole = amountBaseUnits / units;
  const remainder = amountBaseUnits % units;
  return `${whole}.${remainder.toString().padStart(6, '0')}`;
}

function isSolanaAddress(address) {
  try {
    new PublicKey(address);
    return true;
  } catch {
    return false;
  }
}

function getDepositAmountFromMeta(meta, walletAddress) {
  if (!meta) return 0n;

  const preBalances = new Map();
  for (const pre of meta.preTokenBalances || []) {
    if (pre.owner !== walletAddress || pre.mint !== USDC_MINT_ADDRESS) continue;
    if (typeof pre.accountIndex !== 'number') continue;
    preBalances.set(pre.accountIndex, parseTokenAmount(pre.uiTokenAmount));
  }

  let totalDeposit = 0n;
  for (const post of meta.postTokenBalances || []) {
    if (post.owner !== walletAddress || post.mint !== USDC_MINT_ADDRESS) continue;
    if (typeof post.accountIndex !== 'number') continue;

    const before = preBalances.get(post.accountIndex) || 0n;
    const after = parseTokenAmount(post.uiTokenAmount);
    const delta = after - before;
    if (delta > 0n) {
      totalDeposit += delta;
    }
  }

  return totalDeposit;
}

async function ensureSystemAccount(transaction) {
  const [systemUser] = await User.findOrCreate({
    where: { email: SYSTEM_USER_EMAIL },
    defaults: {
      name: SYSTEM_USER_NAME,
      is_verified: true,
      kyc_status: 'pending',
      preferred_chain: 'solana',
    },
    transaction,
  });

  const [systemAccount] = await Account.findOrCreate({
    where: { user_id: systemUser.id, asset: 'USDC' },
    defaults: {
      available_balance: 0,
      pending_balance: 0,
    },
    transaction,
  });

  return systemAccount;
}

async function processDeposit(wallet, signature) {
  const existing = await Transaction.findOne({
    where: { tx_hash: signature, type: 'deposit', asset: 'USDC' },
  });
  if (existing) return false;

  const tx = await connection.getParsedTransaction(signature, { commitment: 'confirmed' });
  if (!tx || !tx.meta) return false;

  const amountBaseUnits = getDepositAmountFromMeta(tx.meta, wallet.address);
  if (amountBaseUnits <= 0n) return false;

  const amountString = formatUsdcAmount(amountBaseUnits);

  await sequelize.transaction(async (transaction) => {
    const userAccount = await Account.findOne({
      where: { user_id: wallet.user_id, asset: 'USDC' },
      transaction,
      lock: transaction.LOCK.UPDATE,
    });

    if (!userAccount) {
      throw new Error(`User account not found for wallet ${wallet.address}`);
    }

    const systemAccount = await ensureSystemAccount(transaction);

    const depositTransaction = await Transaction.create(
      {
        user_id: wallet.user_id,
        type: 'deposit',
        amount: amountString,
        asset: 'USDC',
        status: 'completed',
        tx_hash: signature,
      },
      { transaction }
    );

    await LedgerEntry.create(
      {
        transaction_id: depositTransaction.id,
        debit_account_id: systemAccount.id,
        credit_account_id: userAccount.id,
        amount: amountString,
      },
      { transaction }
    );

    await userAccount.increment({ available_balance: amountString }, { transaction });
  });

  console.log(`Deposit detected ${amountString} USDC for wallet ${wallet.address}`);
  return true;
}

export async function checkDeposits() {
  try {
    const wallets = await Wallet.findAll({
      where: { chain: 'solana' },
      attributes: ['user_id', 'address'],
    });

    for (const wallet of wallets) {
      if (!wallet.address || !isSolanaAddress(wallet.address)) continue;

      const publicKey = new PublicKey(wallet.address);
      const signatures = await connection.getSignaturesForAddress(publicKey, { limit: 20 });

      for (const sig of signatures) {
        if (processedSignatures.has(sig.signature)) continue;

        try {
          const credited = await processDeposit(wallet, sig.signature);
          if (credited) {
            processedSignatures.add(sig.signature);
          }
        } catch (error) {
          console.error(`Deposit processing failed for ${sig.signature} (${wallet.address}):`, error?.message || error);
        }
      }
    }
  } catch (error) {
    console.error('Deposit check error:', error);
  }
}

setInterval(checkDeposits, POLL_INTERVAL_MS);
checkDeposits();