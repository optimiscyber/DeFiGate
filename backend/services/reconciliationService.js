// services/reconciliationService.js
import { Connection, PublicKey } from '@solana/web3.js';
import { sequelize, User, Account, Transaction, Wallet, AuditLog } from '../models/index.js';
import { logAuditEvent, AUDIT_ACTIONS } from './auditService.js';
import { Op } from 'sequelize';

const SOLANA_RPC_URL = process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';
const USDC_MINT = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
const connection = new Connection(SOLANA_RPC_URL, 'confirmed');

/**
 * Get USDC balance from Solana blockchain for a wallet address
 */
async function getBlockchainUSDCBalance(walletAddress) {
  try {
    const publicKey = new PublicKey(walletAddress);
    const tokenAccounts = await connection.getTokenAccountsByOwner(publicKey, {
      mint: USDC_MINT,
    });

    let totalBalance = 0n;
    for (const tokenAccount of tokenAccounts.value) {
      const accountInfo = await connection.getAccountInfo(tokenAccount.account.owner);
      if (accountInfo) {
        const balance = await connection.getTokenAccountBalance(tokenAccount.pubkey);
        if (balance.value.uiAmount) {
          totalBalance += BigInt(Math.floor(balance.value.uiAmount * 1000000)); // Convert to base units
        }
      }
    }

    return totalBalance;
  } catch (error) {
    console.error(`Failed to get blockchain balance for ${walletAddress}:`, error);
    return null;
  }
}

/**
 * Get app ledger balance for a user (only completed transactions)
 */
async function getAppLedgerBalance(userId, asset = 'USDC') {
  const account = await Account.findOne({
    where: { user_id: userId, asset },
  });

  if (!account) return 0;

  // Calculate balance from ONLY completed ledger entries
  const [result] = await sequelize.query(`
    SELECT
      COALESCE(SUM(CASE WHEN le.credit_account_id = a.id THEN le.amount END), 0) -
      COALESCE(SUM(CASE WHEN le.debit_account_id = a.id THEN le.amount END), 0) as ledger_balance
    FROM accounts a
    LEFT JOIN ledger_entries le ON (le.debit_account_id = a.id OR le.credit_account_id = a.id)
    LEFT JOIN transactions t ON le.transaction_id = t.id
    WHERE a.id = ? AND (t.status = 'completed' OR t.status IS NULL)
  `, {
    replacements: [account.id],
    type: sequelize.QueryTypes.SELECT
  });

  return parseFloat(result.ledger_balance || 0);
}

/**
 * Reconcile a single wallet
 */
async function reconcileWallet(wallet) {
  const blockchainBalance = await getBlockchainUSDCBalance(wallet.address);
  if (blockchainBalance === null) {
    return {
      wallet_id: wallet.id,
      address: wallet.address,
      status: 'error',
      error: 'Failed to fetch blockchain balance'
    };
  }

  const appBalance = await getAppLedgerBalance(wallet.user_id, 'USDC');
  const blockchainBalanceFloat = parseFloat(blockchainBalance.toString()) / 1000000; // Convert from base units

  const difference = blockchainBalanceFloat - appBalance;

  const result = {
    wallet_id: wallet.id,
    address: wallet.address,
    blockchain_balance: blockchainBalanceFloat,
    app_balance: appBalance,
    difference: difference,
    status: Math.abs(difference) < 0.01 ? 'matched' : 'mismatch'
  };

  // Log reconciliation result
  await logAuditEvent(AUDIT_ACTIONS.RECONCILIATION_RUN, {
    user_id: wallet.user_id,
    wallet_id: wallet.id,
    metadata: {
      blockchain_balance: blockchainBalanceFloat,
      app_balance: appBalance,
      difference: difference,
      status: result.status
    }
  });

  // Log mismatch if found
  if (result.status === 'mismatch') {
    await logAuditEvent(AUDIT_ACTIONS.RECONCILIATION_MISMATCH, {
      user_id: wallet.user_id,
      wallet_id: wallet.id,
      amount: difference.toString(),
      asset: 'USDC',
      metadata: {
        blockchain_balance: blockchainBalanceFloat,
        app_balance: appBalance,
        difference: difference
      }
    });
  }

  return result;
}

/**
 * Run reconciliation for all wallets
 */
export async function runReconciliation(options = {}) {
  const { walletId, userId } = options;

  let wallets;
  if (walletId) {
    wallets = await Wallet.findAll({ where: { id: walletId } });
  } else if (userId) {
    wallets = await Wallet.findAll({ where: { user_id: userId } });
  } else {
    wallets = await Wallet.findAll({ where: { chain: 'solana' } });
  }

  const results = [];
  for (const wallet of wallets) {
    if (!wallet.address) continue;
    try {
      const result = await reconcileWallet(wallet);
      results.push(result);
    } catch (error) {
      results.push({
        wallet_id: wallet.id,
        address: wallet.address,
        status: 'error',
        error: error.message
      });
    }
  }

  return {
    total_wallets: results.length,
    matched: results.filter(r => r.status === 'matched').length,
    mismatches: results.filter(r => r.status === 'mismatch').length,
    errors: results.filter(r => r.status === 'error').length,
    results
  };
}

/**
 * Auto-repair safe mismatches (when blockchain > app balance)
 * This handles cases where deposits were missed
 * NEVER repairs when blockchain < app (could indicate fraud/withdrawal issues)
 */
export async function autoRepairSafeMismatches() {
  const reconciliation = await runReconciliation();
  const repairs = [];

  for (const result of reconciliation.results) {
    // Only repair when blockchain has MORE than app (missed deposits)
    // Never repair when blockchain has LESS (could be fraud, failed withdrawals, etc.)
    if (result.status === 'mismatch' && result.difference > 0.01 && result.difference < 1000) {
      // Additional safety: don't repair extremely large amounts without manual review
      try {
        // Find the wallet and user
        const wallet = await Wallet.findByPk(result.wallet_id);
        if (!wallet) continue;

        // Double-check: ensure this wallet actually received deposits recently
        // This prevents repairing wallets that just happen to have balances
        const recentDeposits = await sequelize.models.Transaction.findAll({
          where: {
            user_id: wallet.user_id,
            type: 'deposit',
            asset: 'USDC',
            status: 'completed',
            created_at: {
              [Op.gte]: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) // Last 30 days
            }
          },
          limit: 1
        });

        if (recentDeposits.length === 0) {
          repairs.push({
            wallet_id: result.wallet_id,
            skipped: true,
            reason: 'No recent deposits found - manual review required'
          });
          continue;
        }

        // Create a repair transaction
        await sequelize.transaction(async (transaction) => {
          const userAccount = await Account.findOne({
            where: { user_id: wallet.user_id, asset: 'USDC' },
            transaction,
            lock: transaction.LOCK.UPDATE,
          });

          if (!userAccount) throw new Error('User account not found');

          const systemUser = await User.findOne({
            where: { email: process.env.SYSTEM_USER_EMAIL || 'system@defigate.internal' },
            transaction,
          });

          if (!systemUser) throw new Error('System user not found');

          const systemAccount = await Account.findOne({
            where: { user_id: systemUser.id, asset: 'USDC' },
            transaction,
          });

          if (!systemAccount) throw new Error('System account not found');

          const repairTransaction = await Transaction.create({
            user_id: wallet.user_id,
            type: 'deposit',
            amount: result.difference.toString(),
            asset: 'USDC',
            status: 'completed',
            tx_hash: `repair_${Date.now()}_${wallet.id}`,
          }, { transaction });

          await sequelize.models.LedgerEntry.create({
            transaction_id: repairTransaction.id,
            debit_account_id: systemAccount.id,
            credit_account_id: userAccount.id,
            amount: result.difference.toString(),
          }, { transaction });

          await userAccount.increment({ available_balance: result.difference.toString() }, { transaction });

          await logAuditEvent(AUDIT_ACTIONS.DEPOSIT_REPROCESSED, {
            user_id: wallet.user_id,
            wallet_id: wallet.id,
            transaction_id: repairTransaction.id,
            amount: result.difference.toString(),
            asset: 'USDC',
            metadata: {
              type: 'auto_repair_reconciliation',
              original_mismatch: result.difference,
              blockchain_balance: result.blockchain_balance,
              app_balance: result.app_balance
            }
          });

          repairs.push({
            wallet_id: result.wallet_id,
            amount_repaired: result.difference,
            transaction_id: repairTransaction.id
          });
        });
      } catch (error) {
        console.error(`Failed to repair wallet ${result.wallet_id}:`, error);
        repairs.push({
          wallet_id: result.wallet_id,
          error: error.message
        });
      }
    } else if (result.status === 'mismatch' && result.difference < -0.01) {
      // Log negative mismatches for manual review
      await logAuditEvent(AUDIT_ACTIONS.RECONCILIATION_MISMATCH, {
        user_id: result.user_id,
        wallet_id: result.wallet_id,
        amount: result.difference.toString(),
        asset: 'USDC',
        metadata: {
          type: 'negative_mismatch_manual_review_required',
          blockchain_balance: result.blockchain_balance,
          app_balance: result.app_balance,
          difference: result.difference
        }
      });

      repairs.push({
        wallet_id: result.wallet_id,
        requires_manual_review: true,
        reason: `Negative mismatch: blockchain ${result.blockchain_balance}, app ${result.app_balance}`
      });
    }
  }

  return {
    total_repairs_attempted: repairs.filter(r => r.transaction_id).length,
    successful_repairs: repairs.filter(r => r.transaction_id).length,
    failed_repairs: repairs.filter(r => r.error).length,
    manual_reviews_required: repairs.filter(r => r.requires_manual_review).length,
    skipped_repairs: repairs.filter(r => r.skipped).length,
    repairs
  };
}