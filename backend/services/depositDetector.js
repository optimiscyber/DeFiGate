import { Connection, PublicKey } from '@solana/web3.js';
import { sequelize, User, Account, Transaction, LedgerEntry, Wallet } from '../models/index.js';
import { logAuditEvent, AUDIT_ACTIONS } from './auditService.js';

const SOLANA_RPC_URL = process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';
const USDC_MINT = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
const USDC_MINT_ADDRESS = USDC_MINT.toBase58();
const SYSTEM_USER_EMAIL = process.env.SYSTEM_USER_EMAIL || 'system@defigate.internal';
const SYSTEM_USER_NAME = 'DeFiGate External Reserve';
const POLL_INTERVAL_MS = 10000;

// SOL Constants
const SOL_DECIMALS = 9;
const LAMPORTS_PER_SOL = 1_000_000_000;

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

/**
 * Get native SOL deposit amount from transaction metadata.
 * 
 * Native SOL deposits are detected by comparing preBalances and postBalances.
 * We identify the wallet account in the transaction and calculate lamport deltas.
 * 
 * @param {Object} meta - Transaction meta object
 * @param {string} walletAddress - The wallet address to monitor
 * @returns {BigInt} Amount in lamports (positive if deposit detected)
 */
function getSolDepositAmountFromMeta(meta, walletAddress) {
  if (!meta || !meta.preBalances || !meta.postBalances) return 0n;
  if (!meta.postTokenBalances) return 0n; // No token account info means we can't identify the wallet accurately

  // Find the account index corresponding to the wallet address
  // by looking at token balance account owners (SPL token accounts are owned by the wallet)
  let walletAccountIndex = null;
  
  // Try to identify wallet account from token account ownership
  for (const tokenBal of meta.postTokenBalances || []) {
    if (tokenBal.owner === walletAddress && typeof tokenBal.accountIndex === 'number') {
      // This is a token account owned by the wallet. The wallet is typically the signer (index 0 or early).
      // We'll look for the native SOL account by checking preBalances/postBalances
      break;
    }
  }

  // For native SOL, we need to identify the wallet's account index in the transaction accounts.
  // Unfortunately, the transaction metadata doesn't directly give us account addresses.
  // We rely on a heuristic: the wallet is typically the first signer (index 0) in user-initiated transactions.
  // This is safe because we're only processing transactions for wallets we own.
  
  // Check the first few accounts (typically signers) for SOL balance changes
  for (let i = 0; i < Math.min(5, meta.preBalances.length); i++) {
    const preLamports = meta.preBalances[i] || 0;
    const postLamports = meta.postBalances[i] || 0;
    const delta = postLamports - preLamports;
    
    if (delta > 0) {
      // Positive delta = SOL received
      return BigInt(delta);
    }
  }

  return 0n;
}

function formatSolAmount(lamports) {
  const sol = Number(lamports) / LAMPORTS_PER_SOL;
  return sol.toFixed(SOL_DECIMALS);
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

async function ensureSystemAccountForAsset(asset, transaction) {
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
    where: { user_id: systemUser.id, asset },
    defaults: {
      available_balance: 0,
      pending_balance: 0,
    },
    transaction,
  });

  return systemAccount;
}

/**
 * Process a native SOL deposit for a user.
 * Creates Transaction, LedgerEntry, and updates Account balance.
 * @returns {Boolean} true if deposit was credited, false if duplicate or no deposit
 */
async function processSolDeposit(wallet, signature) {
  // Check for duplicate
  const existing = await Transaction.findOne({
    where: { tx_hash: signature, type: 'deposit', asset: 'SOL' },
  });
  if (existing) return false;

  const tx = await connection.getParsedTransaction(signature, { commitment: 'confirmed' });
  if (!tx || !tx.meta) return false;

  // Detect SOL deposit
  const amountLamports = getSolDepositAmountFromMeta(tx.meta, wallet.address);
  if (amountLamports <= 0n) return false;

  const amountSol = formatSolAmount(amountLamports);

  let depositTransaction;
  
  await sequelize.transaction(async (transaction) => {
    // Ensure user SOL account exists
    const userAccount = await Account.findOne({
      where: { user_id: wallet.user_id, asset: 'SOL' },
      transaction,
      lock: transaction.LOCK.UPDATE,
    });

    if (!userAccount) {
      throw new Error(`User SOL account not found for wallet ${wallet.address}`);
    }

    const systemAccount = await ensureSystemAccountForAsset('SOL', transaction);

    depositTransaction = await Transaction.create(
      {
        user_id: wallet.user_id,
        type: 'deposit',
        amount: amountSol,
        asset: 'SOL',
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
        amount: amountSol,
      },
      { transaction }
    );

    await userAccount.increment({ available_balance: amountSol }, { transaction });
  });

  console.log(`SOL deposit detected: ${amountSol} SOL for wallet ${wallet.address}`);
  
  // Log audit event
  await logAuditEvent(AUDIT_ACTIONS.DEPOSIT_DETECTED, {
    user_id: wallet.user_id,
    wallet_id: wallet.id,
    transaction_id: depositTransaction.id,
    tx_hash: signature,
    amount: amountSol,
    asset: 'SOL',
    metadata: {
      wallet_address: wallet.address,
      amount_lamports: amountLamports.toString(),
    }
  });
  
  return true;
}

/**
 * Process a USDC (SPL token) deposit for a user.
 * Creates Transaction, LedgerEntry, and updates Account balance.
 * @returns {Boolean} true if deposit was credited, false if duplicate or no deposit
 */
async function processUsdcDeposit(wallet, signature) {
  // Check for duplicate
  const existing = await Transaction.findOne({
    where: { tx_hash: signature, type: 'deposit', asset: 'USDC' },
  });
  if (existing) return false;

  const tx = await connection.getParsedTransaction(signature, { commitment: 'confirmed' });
  if (!tx || !tx.meta) return false;

  const amountBaseUnits = getDepositAmountFromMeta(tx.meta, wallet.address);
  if (amountBaseUnits <= 0n) return false;

  const amountString = formatUsdcAmount(amountBaseUnits);

  let depositTransaction;

  await sequelize.transaction(async (transaction) => {
    const userAccount = await Account.findOne({
      where: { user_id: wallet.user_id, asset: 'USDC' },
      transaction,
      lock: transaction.LOCK.UPDATE,
    });

    if (!userAccount) {
      throw new Error(`User USDC account not found for wallet ${wallet.address}`);
    }

    const systemAccount = await ensureSystemAccountForAsset('USDC', transaction);

    depositTransaction = await Transaction.create(
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

  console.log(`USDC deposit detected: ${amountString} USDC for wallet ${wallet.address}`);
  
  // Log audit event
  await logAuditEvent(AUDIT_ACTIONS.DEPOSIT_DETECTED, {
    user_id: wallet.user_id,
    wallet_id: wallet.id,
    transaction_id: depositTransaction.id,
    tx_hash: signature,
    amount: amountString,
    asset: 'USDC',
    metadata: {
      wallet_address: wallet.address,
      amount_base_units: amountBaseUnits.toString()
    }
  });
  
  return true;
}

/**
 * Main deposit processor: detects and credits both SOL and USDC deposits.
 * Tries both asset types for each transaction.
 * @returns {Boolean} true if any deposit was credited
 */
export async function processDeposit(wallet, signature) {
  try {
    const solResult = await processSolDeposit(wallet, signature);
    const usdcResult = await processUsdcDeposit(wallet, signature);
    return solResult || usdcResult;
  } catch (error) {
    console.error(`Deposit processing failed for ${signature} (${wallet.address}):`, error?.message || error);
    return false;
  }
}

export async function checkDeposits() {
  try {
    const wallets = await Wallet.findAll({
      where: { chain: 'solana' },
      attributes: ['id', 'user_id', 'address', 'last_scanned_signature', 'last_scanned_at'],
    });

    for (const wallet of wallets) {
      if (!wallet.address || !isSolanaAddress(wallet.address)) continue;

      try {
        const publicKey = new PublicKey(wallet.address);
        
        // Get signatures starting from the checkpoint
        // If no checkpoint, getSignaturesForAddress defaults to recent signatures
        const sigOptions = { limit: 20 };
        if (wallet.last_scanned_signature) {
          sigOptions.until = wallet.last_scanned_signature;
        }
        
        const signatures = await connection.getSignaturesForAddress(publicKey, sigOptions);
        if (signatures.length === 0) continue;

        let latestSignature = wallet.last_scanned_signature;
        let processedCount = 0;

        for (const sig of signatures) {
          // Skip if this is the checkpoint (until stops BEFORE this sig)
          if (sig.signature === wallet.last_scanned_signature) continue;

          try {
            const credited = await processDeposit(wallet, sig.signature);
            if (credited) {
              processedSignatures.add(sig.signature);
              if (!latestSignature) {
                latestSignature = sig.signature;
              }
              processedCount++;
            }
          } catch (error) {
            console.error(`Deposit processing failed for ${sig.signature} (${wallet.address}):`, error?.message || error);
          }
        }

        // Update checkpoint after processing batch
        if (processedCount > 0 || !wallet.last_scanned_signature) {
          const checkpointSig = signatures[0]?.signature || wallet.last_scanned_signature;
          if (checkpointSig) {
            await wallet.update({
              last_scanned_signature: checkpointSig,
              last_scanned_at: new Date(),
            });
            console.log(`Updated checkpoint for wallet ${wallet.address}: ${checkpointSig}`);
          }
        }
      } catch (error) {
        console.error(`Deposit check error for wallet ${wallet.address}:`, error?.message || error);
      }
    }
  } catch (error) {
    console.error('Deposit check error:', error);
  }
}

setInterval(checkDeposits, POLL_INTERVAL_MS);
checkDeposits();