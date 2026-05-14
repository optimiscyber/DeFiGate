import { Connection, PublicKey } from '@solana/web3.js';
import { sequelize, User, Account, Wallet, Transaction, LedgerEntry } from '../models/index.js';
import { getAppLedgerBalance } from './reconciliationService.js';
import { logAuditEvent, AUDIT_ACTIONS } from './auditService.js';

const SOLANA_RPC_URL = process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';
const USDC_MINT = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
const connection = new Connection(SOLANA_RPC_URL, 'confirmed');
const LAMPORTS_PER_SOL = 1_000_000_000;
const DEFAULT_SIGNATURE_LOOKBACK = parseInt(process.env.BALANCE_SYNC_SIGNATURE_LIMIT || '50', 10);

async function getOnchainSolBalance(walletAddress) {
  try {
    const publicKey = new PublicKey(walletAddress);
    const lamports = await connection.getBalance(publicKey, 'confirmed');
    return lamports / LAMPORTS_PER_SOL;
  } catch (error) {
    console.error(`getOnchainSolBalance failed for ${walletAddress}`, error?.message || error);
    return null;
  }
}

async function getOnchainUsdcBalance(walletAddress) {
  try {
    const publicKey = new PublicKey(walletAddress);
    const tokenAccounts = await connection.getTokenAccountsByOwner(publicKey, {
      mint: USDC_MINT,
    });

    let totalBaseUnits = 0n;
    for (const tokenAccount of tokenAccounts.value) {
      const balance = await connection.getTokenAccountBalance(tokenAccount.pubkey, 'confirmed');
      const uiAmount = balance?.value?.uiAmount || 0;
      totalBaseUnits += BigInt(Math.round(uiAmount * 1_000_000));
    }

    return Number(totalBaseUnits) / 1_000_000;
  } catch (error) {
    console.error(`getOnchainUsdcBalance failed for ${walletAddress}`, error?.message || error);
    return null;
  }
}

function parseTokenAmount(tokenBalance) {
  if (!tokenBalance || !tokenBalance.uiTokenAmount) return 0n;
  return BigInt(String(tokenBalance.uiTokenAmount.amount || '0'));
}

function getDepositAmountsFromMeta(meta, walletAddress) {
  if (!meta) return { sol: 0n, usdc: 0n };

  let solDeposit = 0n;
  if (Array.isArray(meta.preBalances) && Array.isArray(meta.postBalances)) {
    for (let i = 0; i < Math.min(meta.preBalances.length, meta.postBalances.length); i++) {
      const delta = BigInt(meta.postBalances[i] || 0) - BigInt(meta.preBalances[i] || 0);
      if (delta > 0n) {
        solDeposit += delta;
      }
    }
  }

  const preUsdc = new Map();
  for (const preToken of meta.preTokenBalances || []) {
    if (preToken.owner !== walletAddress || preToken.mint !== USDC_MINT.toBase58()) continue;
    if (typeof preToken.accountIndex !== 'number') continue;
    preUsdc.set(preToken.accountIndex, parseTokenAmount(preToken));
  }

  let usdcDeposit = 0n;
  for (const postToken of meta.postTokenBalances || []) {
    if (postToken.owner !== walletAddress || postToken.mint !== USDC_MINT.toBase58()) continue;
    if (typeof postToken.accountIndex !== 'number') continue;
    const before = preUsdc.get(postToken.accountIndex) || 0n;
    const after = parseTokenAmount(postToken);
    const delta = after - before;
    if (delta > 0n) {
      usdcDeposit += delta;
    }
  }

  return { sol: solDeposit, usdc: usdcDeposit };
}

async function ensureUserAccount(userId, asset) {
  const [account] = await Account.findOrCreate({
    where: { user_id: userId, asset },
    defaults: {
      available_balance: 0,
      pending_balance: 0,
    },
  });
  return account;
}

async function ensureSystemAccountForAsset(asset, transaction) {
  const systemEmail = process.env.SYSTEM_USER_EMAIL || 'system@defigate.internal';

  const [systemUser] = await User.findOrCreate({
    where: { email: systemEmail },
    defaults: {
      name: 'DeFiGate External Reserve',
      is_verified: true,
      kyc_status: 'pending',
      preferred_chain: 'solana',
    },
    transaction,
  });

  const [systemAccount] = await Account.findOrCreate({
    where: { user_id: systemUser.id, asset },
    defaults: {
      available_balance: 0,
      pending_balance: 0,
    },
    transaction,
  });

  return systemAccount;
}

async function createDepositTransaction(wallet, amount, asset, txHash, transaction) {
  return await Transaction.create(
    {
      user_id: wallet.user_id,
      type: 'deposit',
      amount,
      asset,
      status: 'completed',
      tx_hash: txHash,
    },
    { transaction }
  );
}

async function createLedgerEntry(transactionId, debitAccountId, creditAccountId, amount, transaction) {
  return await LedgerEntry.create(
    {
      transaction_id: transactionId,
      debit_account_id: debitAccountId,
      credit_account_id: creditAccountId,
      amount,
    },
    { transaction }
  );
}

export async function syncWalletBalances(wallet) {
  if (!wallet || !wallet.address) {
    return {
      wallet_id: wallet?.id || null,
      status: 'error',
      error: 'Missing wallet address',
    };
  }

  const [usdcOnchain, solOnchain] = await Promise.all([
    getOnchainUsdcBalance(wallet.address),
    getOnchainSolBalance(wallet.address),
  ]);

  const [usdcApp, solApp] = await Promise.all([
    getAppLedgerBalance(wallet.user_id, 'USDC'),
    getAppLedgerBalance(wallet.user_id, 'SOL'),
  ]);

  const result = {
    wallet_id: wallet.id,
    address: wallet.address,
    asset_balances: {
      USDC: {
        blockchain: usdcOnchain,
        app: usdcApp,
        difference: usdcOnchain === null ? null : usdcOnchain - usdcApp,
        status: usdcOnchain === null ? 'error' : Math.abs(usdcOnchain - usdcApp) < 0.01 ? 'matched' : 'mismatch',
      },
      SOL: {
        blockchain: solOnchain,
        app: solApp,
        difference: solOnchain === null ? null : solOnchain - solApp,
        status: solOnchain === null ? 'error' : Math.abs(solOnchain - solApp) < 0.00001 ? 'matched' : 'mismatch',
      },
    },
  };

  await logAuditEvent(AUDIT_ACTIONS.RECONCILIATION_RUN, {
    user_id: wallet.user_id,
    wallet_id: wallet.id,
    metadata: {
      usdc: result.asset_balances.USDC,
      sol: result.asset_balances.SOL,
    },
    request_id: `balance_sync_${Date.now()}`,
  });

  return result;
}

export async function syncAllUserWallets(options = {}) {
  const where = { chain: 'solana' };
  if (options.userId) {
    where.user_id = options.userId;
  }
  if (options.walletId) {
    where.id = options.walletId;
  }

  const wallets = await Wallet.findAll({ where });
  const results = [];
  for (const wallet of wallets) {
    if (!wallet.address) continue;
    try {
      results.push(await syncWalletBalances(wallet));
    } catch (error) {
      results.push({
        wallet_id: wallet.id,
        address: wallet.address,
        status: 'error',
        error: error?.message || 'Balance sync failed',
      });
    }
  }

  return results;
}

export async function repairMissingDeposits(options = {}) {
  const where = { chain: 'solana' };
  if (options.userId) {
    where.user_id = options.userId;
  }
  if (options.walletId) {
    where.id = options.walletId;
  }

  const wallets = await Wallet.findAll({ where });
  const repairs = [];

  for (const wallet of wallets) {
    if (!wallet.address) continue;

    const publicKey = new PublicKey(wallet.address);
    let signatures;
    try {
      signatures = await connection.getSignaturesForAddress(publicKey, {
        limit: DEFAULT_SIGNATURE_LOOKBACK,
      });
    } catch (error) {
      repairs.push({ wallet_id: wallet.id, status: 'error', error: error?.message || 'Failed fetching signatures' });
      continue;
    }

    for (const sig of signatures) {
      const txHash = sig.signature;
      const existing = await Transaction.findOne({ where: { tx_hash: txHash, type: 'deposit' } });
      if (existing) continue;

      const tx = await connection.getParsedTransaction(txHash, { commitment: 'confirmed' });
      if (!tx || !tx.meta) continue;

      const { sol, usdc } = getDepositAmountsFromMeta(tx.meta, wallet.address);
      const txResults = [];

      if (sol > 0n) {
        const amount = Number(sol) / LAMPORTS_PER_SOL;
        await sequelize.transaction(async (transaction) => {
          const account = await ensureUserAccount(wallet.user_id, 'SOL');
          const systemAccount = await ensureSystemAccountForAsset('SOL', transaction);
          const depositTx = await createDepositTransaction(wallet, amount, 'SOL', txHash, transaction);
          await createLedgerEntry(depositTx.id, systemAccount.id, account.id, amount, transaction);
          await account.increment({ available_balance: amount }, { transaction });
          txResults.push({ asset: 'SOL', amount });
        });
      }

      if (usdc > 0n) {
        const amount = Number(usdc) / 1_000_000;
        await sequelize.transaction(async (transaction) => {
          const account = await ensureUserAccount(wallet.user_id, 'USDC');
          const systemAccount = await ensureSystemAccountForAsset('USDC', transaction);
          const depositTx = await createDepositTransaction(wallet, amount, 'USDC', txHash, transaction);
          await createLedgerEntry(depositTx.id, systemAccount.id, account.id, amount, transaction);
          await account.increment({ available_balance: amount }, { transaction });
          txResults.push({ asset: 'USDC', amount });
        });
      }

      if (txResults.length > 0) {
        await logAuditEvent(AUDIT_ACTIONS.DEPOSIT_REPROCESSED, {
          user_id: wallet.user_id,
          wallet_id: wallet.id,
          tx_hash: txHash,
          metadata: {
            repairs: txResults,
          },
          request_id: `repair_deposit_${Date.now()}`,
        });
        repairs.push({ wallet_id: wallet.id, tx_hash: txHash, repairs: txResults, status: 'repaired' });
      }
    }
  }

  return repairs;
}

export function startBalanceSyncJob(requestContext = {}) {
  const intervalMs = parseInt(process.env.BALANCE_SYNC_INTERVAL_MS || String(10 * 60 * 1000), 10);
  syncAllUserWallets().catch((error) => {
    console.error('Initial balance sync failed:', error?.message || error);
  });
  setInterval(() => {
    syncAllUserWallets().catch((error) => {
      console.error('Background balance sync failed:', error?.message || error);
    });
  }, intervalMs);
}
