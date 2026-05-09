// controllers/adminController.js
import { runReconciliation, autoRepairSafeMismatches } from '../services/reconciliationService.js';
import { processDeposit } from '../services/depositDetector.js';
import { Wallet, Transaction } from '../models/index.js';
import { logAuditEvent, AUDIT_ACTIONS, getAuditLogs } from '../services/auditService.js';
import { respondError, respondSuccess } from '../utils/response.js';

/**
 * POST /admin/reconcile
 * Run reconciliation for all wallets or specific wallet/user
 */
export const reconcile = async (req, res) => {
  try {
    const { walletId, userId, autoRepair } = req.body;

    const result = await runReconciliation({ walletId, userId });

    // Optionally auto-repair safe mismatches
    let repairResult = null;
    if (autoRepair && result.mismatches > 0) {
      repairResult = await autoRepairSafeMismatches();
    }

    await logAuditEvent(AUDIT_ACTIONS.ADMIN_ACTION, {
      user_id: req.user?.id,
      metadata: {
        action: 'reconciliation_run',
        wallet_id: walletId,
        user_id: userId,
        auto_repair: autoRepair,
        results: result
      },
      ip_address: req.ip,
      user_agent: req.get('User-Agent')
    });

    respondSuccess(res, {
      reconciliation: result,
      repairs: repairResult
    });
  } catch (error) {
    console.error('Reconciliation error:', error);
    respondError(res, 500, 'Reconciliation failed', true, error.message);
  }
};

/**
 * POST /admin/deposits/reprocess
 * Manually reprocess a deposit transaction
 */
export const reprocessDeposit = async (req, res) => {
  try {
    const { txHash } = req.body;

    if (!txHash) {
      return respondError(res, 400, 'txHash is required');
    }

    // Check if transaction already exists
    const existingTx = await Transaction.findOne({
      where: { tx_hash: txHash, type: 'deposit' }
    });

    if (existingTx) {
      return respondError(res, 409, 'Transaction already processed');
    }

    // Find wallet that should receive this deposit
    // This is a simplified version - in production you'd need to determine
    // which wallet the tx_hash belongs to
    const wallets = await Wallet.findAll({
      where: { chain: 'solana' },
      attributes: ['id', 'user_id', 'address']
    });

    let processed = false;
    let processedWallet = null;

    for (const wallet of wallets) {
      if (!wallet.address) continue;

      try {
        const credited = await processDeposit(wallet, txHash);
        if (credited) {
          processed = true;
          processedWallet = wallet;
          break;
        }
      } catch (error) {
        console.error(`Failed to process ${txHash} for wallet ${wallet.address}:`, error);
      }
    }

    if (!processed) {
      return respondError(res, 404, 'Transaction not found or not a valid deposit');
    }

    await logAuditEvent(AUDIT_ACTIONS.DEPOSIT_REPROCESSED, {
      user_id: req.user?.id,
      wallet_id: processedWallet?.id,
      tx_hash: txHash,
      metadata: {
        type: 'manual_reprocess',
        admin_user_id: req.user?.id
      },
      ip_address: req.ip,
      user_agent: req.get('User-Agent')
    });

    respondSuccess(res, {
      message: 'Deposit reprocessed successfully',
      tx_hash: txHash,
      wallet_id: processedWallet?.id
    });
  } catch (error) {
    console.error('Deposit reprocessing error:', error);
    respondError(res, 500, 'Deposit reprocessing failed', true, error.message);
  }
};

/**
 * GET /admin/audit-logs
 * Get audit logs with filtering
 */
export const getAuditLogsEndpoint = async (req, res) => {
  try {
    const {
      user_id,
      action,
      from_date,
      to_date,
      limit = 100,
      offset = 0
    } = req.query;

    const filters = {
      user_id,
      action,
      from_date: from_date ? new Date(from_date) : undefined,
      to_date: to_date ? new Date(to_date) : undefined,
      limit: parseInt(limit),
      offset: parseInt(offset)
    };

    const logs = await getAuditLogs(filters);

    respondSuccess(res, {
      logs,
      filters
    });
  } catch (error) {
    console.error('Audit logs error:', error);
    respondError(res, 500, 'Failed to fetch audit logs', true, error.message);
  }
};