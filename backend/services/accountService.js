import { sequelize, Account, Wallet, AccountLedger } from "../models/index.js";
import { logAuditEvent, AUDIT_ACTIONS } from "./auditService.js";

const DEFAULT_ASSET = "USDC";
const AMOUNT_REGEX = /^-?\d+(?:\.\d{1,6})?$/;

function normalizeAsset(asset) {
  return String(asset || DEFAULT_ASSET).trim().toUpperCase();
}

function normalizeAmount(amount) {
  const amountString = String(amount).trim();
  if (!AMOUNT_REGEX.test(amountString)) {
    throw new Error("INVALID_AMOUNT");
  }
  return amountString;
}

async function getOrCreateAccount(userId, asset = DEFAULT_ASSET, transaction = null) {
  const [account] = await Account.findOrCreate({
    where: { user_id: userId, asset: normalizeAsset(asset) },
    defaults: {
      available_balance: 0,
      pending_balance: 0,
      is_frozen: false,
      freeze_reason: null,
    },
    transaction,
  });
  return account;
}

async function getRawDerivedBalance(userId, asset = DEFAULT_ASSET) {
  const [result] = await sequelize.query(
    `SELECT COALESCE(SUM(amount), 0) AS derived_balance
     FROM account_ledger
     WHERE user_id = $1 AND asset = $2`,
    {
      bind: [userId, normalizeAsset(asset)],
      type: sequelize.QueryTypes.SELECT,
    }
  );

  return parseFloat(result.derived_balance || 0);
}

async function syncAccountCache(userId, asset = DEFAULT_ASSET, transaction = null) {
  const derivedBalance = await getRawDerivedBalance(userId, asset);
  const account = await getOrCreateAccount(userId, asset, transaction);
  const cachedBalance = parseFloat(account.available_balance || 0);

  if (Math.abs(cachedBalance - derivedBalance) > 0.000001) {
    const update = { available_balance: derivedBalance };
    if (transaction) {
      await account.update(update, { transaction });
    } else {
      await account.update(update);
    }

    await logAuditEvent(AUDIT_ACTIONS.RECONCILIATION_MISMATCH, {
      user_id: userId,
      wallet_id: account.id,
      amount: (derivedBalance - cachedBalance).toString(),
      asset: normalizeAsset(asset),
      metadata: {
        derived_balance: derivedBalance,
        cached_balance: cachedBalance,
      },
    });
  }

  return derivedBalance;
}

async function addLedgerEntry({
  userId,
  walletId = null,
  asset = DEFAULT_ASSET,
  type = "adjustment",
  amount,
  txHash = null,
  metadata = null,
  transaction = null,
}) {
  if (!userId || !amount) {
    throw new Error("INVALID_LEDGER_ENTRY");
  }

  const normalizedAmount = normalizeAmount(amount);
  const entry = await AccountLedger.create(
    {
      user_id: userId,
      wallet_id: walletId,
      asset: normalizeAsset(asset),
      type,
      amount: normalizedAmount,
      tx_hash: txHash,
      metadata,
    },
    { transaction }
  );

  await syncAccountCache(userId, asset, transaction);
  return entry;
}

export async function getDerivedBalance(userId, asset = DEFAULT_ASSET) {
  const balance = await syncAccountCache(userId, asset);
  return balance;
}

export async function creditAccount(userId, amount, options = {}) {
  const { asset = DEFAULT_ASSET, walletId = null, txHash = null, metadata = null, transaction = null } = options;
  if (parseFloat(amount) <= 0) {
    throw new Error("INVALID_AMOUNT");
  }
  return addLedgerEntry({
    userId,
    walletId,
    asset,
    type: "deposit",
    amount,
    txHash,
    metadata,
    transaction,
  });
}

export async function debitAccount(userId, amount, options = {}) {
  const { asset = DEFAULT_ASSET, walletId = null, txHash = null, metadata = null, transaction = null } = options;
  if (parseFloat(amount) <= 0) {
    throw new Error("INVALID_AMOUNT");
  }
  return addLedgerEntry({
    userId,
    walletId,
    asset,
    type: "withdrawal",
    amount: `-${normalizeAmount(amount)}`,
    txHash,
    metadata,
    transaction,
  });
}

export async function adjustAccount(userId, amount, options = {}) {
  const { asset = DEFAULT_ASSET, walletId = null, txHash = null, metadata = null, transaction = null } = options;
  if (parseFloat(amount) === 0) {
    throw new Error("INVALID_AMOUNT");
  }
  return addLedgerEntry({
    userId,
    walletId,
    asset,
    type: "adjustment",
    amount,
    txHash,
    metadata,
    transaction,
  });
}

export async function freezeAccount(userId, asset = DEFAULT_ASSET, reason = "system freeze", transaction = null) {
  const account = await getOrCreateAccount(userId, asset, transaction);
  const update = {
    is_frozen: true,
    freeze_reason: String(reason || "frozen by system"),
  };
  if (transaction) {
    await account.update(update, { transaction });
  } else {
    await account.update(update);
  }
  await logAuditEvent(AUDIT_ACTIONS.ADMIN_ACTION, {
    user_id: userId,
    wallet_id: account.id,
    metadata: {
      action: "freeze_account",
      asset: normalizeAsset(asset),
      reason,
    },
  });
  return account;
}

export async function reserveFunds(userId, amount, options = {}) {
  const { asset = DEFAULT_ASSET, transaction = null } = options;
  if (parseFloat(amount) <= 0) {
    throw new Error("INVALID_AMOUNT");
  }

  const account = await getOrCreateAccount(userId, asset, transaction);
  const current = parseFloat(account.available_balance || 0);
  if (current < parseFloat(amount)) {
    throw new Error("INSUFFICIENT_FUNDS");
  }

  const update = {
    available_balance: (current - parseFloat(amount)).toString(),
    pending_balance: (parseFloat(account.pending_balance || 0) + parseFloat(amount)).toString(),
  };

  await account.update(update, transaction ? { transaction } : undefined);
  return account;
}

export async function releaseFunds(userId, amount, options = {}) {
  const { asset = DEFAULT_ASSET, transaction = null } = options;
  if (parseFloat(amount) <= 0) {
    throw new Error("INVALID_AMOUNT");
  }

  const account = await getOrCreateAccount(userId, asset, transaction);
  const currentPending = parseFloat(account.pending_balance || 0);
  if (currentPending < parseFloat(amount)) {
    throw new Error("INSUFFICIENT_PENDING_FUNDS");
  }

  const update = {
    available_balance: (parseFloat(account.available_balance || 0) + parseFloat(amount)).toString(),
    pending_balance: (currentPending - parseFloat(amount)).toString(),
  };

  await account.update(update, transaction ? { transaction } : undefined);
  return account;
}

export async function commitReservedFunds(userId, amount, options = {}) {
  const { asset = DEFAULT_ASSET, walletId = null, txHash = null, metadata = null, transaction = null } = options;
  if (parseFloat(amount) <= 0) {
    throw new Error("INVALID_AMOUNT");
  }

  const account = await getOrCreateAccount(userId, asset, transaction);
  const currentPending = parseFloat(account.pending_balance || 0);
  if (currentPending < parseFloat(amount)) {
    throw new Error("INSUFFICIENT_PENDING_FUNDS");
  }

  await addLedgerEntry({
    userId,
    walletId,
    asset,
    type: "withdrawal",
    amount: `-${normalizeAmount(amount)}`,
    txHash,
    metadata,
    transaction,
  });

  const update = {
    pending_balance: (currentPending - parseFloat(amount)).toString(),
  };
  await account.update(update, transaction ? { transaction } : undefined);
  return account;
}

export async function getAccountCache(userId, asset = DEFAULT_ASSET) {
  return await getOrCreateAccount(userId, asset);
}
