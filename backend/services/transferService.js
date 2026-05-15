import { sequelize } from "../models/index.js";
import Account from "../models/Account.js";
import Transaction from "../models/Transaction.js";
import { creditAccount, debitAccount } from '../services/accountService.js';
import { logAuditEvent, AUDIT_ACTIONS } from './auditService.js';

const DEFAULT_ASSET = "USDC";
const AMOUNT_REGEX = /^\d+(?:\.\d{1,6})?$/;
const DECIMAL_SCALE = 6;

function normalizeAmount(amount) {
  const amountString = String(amount).trim();
  if (!AMOUNT_REGEX.test(amountString)) {
    throw new Error("INVALID_AMOUNT");
  }
  if (amountString === "0" || /^0+(\.0+)?$/.test(amountString)) {
    throw new Error("INVALID_AMOUNT");
  }
  return amountString;
}

function scaleAmount(value) {
  const [integer, fraction = ""] = String(value).split(".");
  const normalizedFraction = fraction.padEnd(DECIMAL_SCALE, "0").slice(0, DECIMAL_SCALE);
  return BigInt(`${integer}${normalizedFraction}`);
}

export async function transferFunds(senderId, receiverId, amount, options = {}) {
  if (!senderId || !receiverId) {
    throw new Error("INVALID_PARTIES");
  }
  if (senderId === receiverId) {
    throw new Error("SELF_TRANSFER_NOT_ALLOWED");
  }

  const asset = options.asset || DEFAULT_ASSET;
  const idempotencyKey = options.idempotencyKey?.trim() || null;
  const reference = options.reference?.trim() || idempotencyKey || null;
  const amountString = normalizeAmount(amount);

  let transactionRecord = null;

  if (reference) {
    transactionRecord = await Transaction.findOne({
      where: {
        user_id: senderId,
        type: "transfer",
        reference,
        asset,
      },
    });

    if (transactionRecord) {
      return transactionRecord;
    }
  }

  transactionRecord = await Transaction.create({
    user_id: senderId,
    type: "transfer",
    status: "pending",
    amount: amountString,
    asset,
    reference,
  });

  try {
    await sequelize.transaction(async (tx) => {
      const orderedUserIds = [senderId, receiverId].sort();
      const accounts = [];

      for (const userId of orderedUserIds) {
        const account = await Account.findOne({
          where: { user_id: userId, asset },
          transaction: tx,
          lock: tx.LOCK.UPDATE,
        });
        accounts.push(account);
      }

      const senderAccount = accounts.find((account) => account?.user_id === senderId);
      const receiverAccount = accounts.find((account) => account?.user_id === receiverId);

      if (!senderAccount) {
        throw new Error("SENDER_ACCOUNT_NOT_FOUND");
      }
      if (!receiverAccount) {
        throw new Error("RECEIVER_ACCOUNT_NOT_FOUND");
      }

      const senderBalanceScaled = scaleAmount(senderAccount.available_balance);
      const requestedScaled = scaleAmount(amountString);
      if (senderBalanceScaled < requestedScaled) {
        throw new Error("INSUFFICIENT_FUNDS");
      }

      await debitAccount(senderId, amountString, {
        asset,
        walletId: null,
        txHash: `transfer_${transactionRecord.id}`,
        metadata: {
          transfer_id: transactionRecord.id,
          receiver_id: receiverId,
        },
        transaction: tx,
      });

      await creditAccount(receiverId, amountString, {
        asset,
        walletId: null,
        txHash: `transfer_${transactionRecord.id}`,
        metadata: {
          transfer_id: transactionRecord.id,
          sender_id: senderId,
        },
        transaction: tx,
      });
    });

    transactionRecord.status = "completed";
    await transactionRecord.save();

    // Log audit event
    await logAuditEvent(AUDIT_ACTIONS.TRANSFER_CONFIRMED, {
      user_id: senderId,
      transaction_id: transactionRecord.id,
      amount: amountString,
      asset: asset,
      metadata: {
        receiver_id: receiverId,
        reference: reference
      }
    });

    return transactionRecord;
  } catch (error) {
    transactionRecord.status = "failed";
    await transactionRecord.save();
    throw error;
  }
}
