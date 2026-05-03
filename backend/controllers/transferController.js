import pool from "../db.js";
import bcrypt from "bcrypt";
import crypto from "crypto";
import dotenv from "dotenv";
import sequelize from "../config/database.js";
import Balance from "../models/Balance.js";
import Account from "../models/Account.js";
import Transaction from "../models/Transaction.js";
import User from "../models/User.js";
import { respondError, respondSuccess } from "../utils/response.js";
import { transferFunds } from "../services/transferService.js";
dotenv.config();

const inMemoryTransfers = new Map();
const inMemoryPINs = new Map(); // Temporary PIN storage: key format = "senderID:transferID"

// Generate a 6-digit PIN
function generatePIN() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

// Resolve recipient by email or phone number
export const lookupRecipient = async (req, res) => {
  const { recipient } = req.body;

  if (!recipient || typeof recipient !== 'string') {
    return res.status(400).json({ ok: false, error: 'Recipient is required' });
  }

  const normalizedRecipient = recipient.trim();
  if (!normalizedRecipient) {
    return res.status(400).json({ ok: false, error: 'Recipient cannot be empty' });
  }

  try {
    const isEmail = normalizedRecipient.includes('@');
    const query = `SELECT id, first_name, last_name, email, phone FROM users WHERE ${isEmail ? 'LOWER(email) = $1' : 'phone = $1'}`;
    const params = [isEmail ? normalizedRecipient.toLowerCase() : normalizedRecipient];

    const result = await pool.query(query, params);

    if (result.rows.length === 0) {
      return res.status(404).json({ ok: false, error: 'Recipient not found' });
    }

    if (result.rows.length > 1) {
      console.error('lookupRecipient ambiguity', normalizedRecipient, result.rows);
      return res.status(500).json({ ok: false, error: 'Multiple recipients found' });
    }

    const recipientUser = result.rows[0];
    const fullName = [recipientUser.first_name, recipientUser.last_name].filter(Boolean).join(' ').trim();

    return res.json({
      ok: true,
      data: {
        userId: recipientUser.id,
        name: fullName || recipientUser.email || recipientUser.phone || 'Unknown User',
        email: recipientUser.email,
        phone: recipientUser.phone,
      },
    });
  } catch (err) {
    console.error('lookupRecipient error', err);
    res.status(500).json({ ok: false, error: 'Lookup failed' });
  }
};

// Initiate transfer - sender specifies recipient and amount
export const initiateTransfer = async (req, res) => {
  const senderId = req.user?.id;
  const senderEmail = req.user?.email;
  const { recipientId, amount, tokenSymbol, chain } = req.body;

  if (!senderId || !senderEmail) {
    return res.status(401).json({ ok: false, error: "Not authenticated" });
  }

  if (!recipientId || !amount || !tokenSymbol || !chain) {
    return res.status(400).json({
      ok: false,
      error: "Missing required fields: recipientId, amount, tokenSymbol, chain",
    });
  }

  if (senderId === recipientId) {
    return res.status(400).json({ ok: false, error: "Cannot send to yourself" });
  }

  if (amount <= 0) {
    return res.status(400).json({ ok: false, error: "Amount must be positive" });
  }

  try {
    const insertResult = await pool.query(
      `INSERT INTO transfers (sender_id, recipient_id, amount, token_symbol, chain, status, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id, sender_id, recipient_id, amount, token_symbol, chain, status, created_at`,
      [
        senderId,
        recipientId,
        amount,
        tokenSymbol,
        chain,
        "pending_confirmation",
        {
          sender_email: senderEmail,
          initiated_at: new Date().toISOString(),
        },
      ]
    );

    const transfer = insertResult.rows[0];
    const pin = generatePIN();

    // Store PIN temporarily (should use Redis in production)
    inMemoryPINs.set(`${senderId}:${transfer.id}`, pin);

    res.json({
      ok: true,
      data: {
        transferId: transfer.id,
        status: transfer.status,
        message: `Transfer initiated. PIN has been sent to ${senderEmail}.`,
        pin, // In development only
      },
    });
  } catch (err) {
    console.error("initiateTransfer error", err);
    res.status(500).json({ ok: false, error: "Transfer initiation failed" });
  }
};

// Confirm transfer with PIN and password
export const confirmTransfer = async (req, res) => {
  const senderId = req.user?.id;
  const { transferId, pin, password } = req.body;

  if (!senderId) {
    return res.status(401).json({ ok: false, error: "Not authenticated" });
  }

  if (!transferId || !pin || !password) {
    return res.status(400).json({
      ok: false,
      error: "Missing required fields: transferId, pin, password",
    });
  }

  try {
    const transferResult = await pool.query(
      `SELECT id, sender_id, recipient_id, amount, token_symbol, status FROM transfers WHERE id = $1`,
      [transferId]
    );

    if (transferResult.rows.length === 0) {
      return res.status(404).json({ ok: false, error: "Transfer not found" });
    }

    const transfer = transferResult.rows[0];

    if (transfer.sender_id !== senderId) {
      return res.status(403).json({ ok: false, error: "Unauthorized" });
    }

    if (transfer.status !== "pending_confirmation") {
      return res.status(400).json({ ok: false, error: "Transfer cannot be confirmed" });
    }

    // Verify PIN
    const storedPin = inMemoryPINs.get(`${senderId}:${transferId}`);
    if (storedPin !== pin) {
      return res.status(400).json({ ok: false, error: "Invalid PIN" });
    }

    // Verify password
    const senderResult = await pool.query(
      `SELECT password_hash FROM users WHERE id = $1`,
      [senderId]
    );

    if (senderResult.rows.length === 0) {
      return res.status(401).json({ ok: false, error: "Sender not found" });
    }

    const sender = senderResult.rows[0];
    const validPassword = await bcrypt.compare(password, sender.password_hash);

    if (!validPassword) {
      return res.status(401).json({ ok: false, error: "Invalid password" });
    }

    // Transfer settlement: adjust balances and complete transfer atomically
    await pool.query("BEGIN");

    const senderBalanceResult = await pool.query(
      `SELECT available_balance FROM balances WHERE user_id = $1 FOR UPDATE`,
      [senderId]
    );

    if (senderBalanceResult.rows.length === 0) {
      await pool.query("ROLLBACK");
      return res.status(404).json({ ok: false, error: "Sender balance not found" });
    }

    const senderBalance = Number(senderBalanceResult.rows[0].available_balance || 0);
    const transferAmount = Number(transfer.amount || 0);

    if (Number.isNaN(transferAmount) || transferAmount <= 0) {
      await pool.query("ROLLBACK");
      return res.status(400).json({ ok: false, error: "Invalid transfer amount" });
    }

    if (senderBalance < transferAmount) {
      await pool.query("ROLLBACK");
      return res.status(400).json({ ok: false, error: "Insufficient funds" });
    }

    const recipientBalanceResult = await pool.query(
      `SELECT available_balance FROM balances WHERE user_id = $1 FOR UPDATE`,
      [transfer.recipient_id]
    );

    if (recipientBalanceResult.rows.length === 0) {
      await pool.query("ROLLBACK");
      return res.status(404).json({ ok: false, error: "Recipient balance not found" });
    }

    await pool.query(
      `UPDATE balances SET available_balance = available_balance - $1 WHERE user_id = $2`,
      [transferAmount, senderId]
    );

    await pool.query(
      `UPDATE balances SET available_balance = available_balance + $1 WHERE user_id = $2`,
      [transferAmount, transfer.recipient_id]
    );

    const updatedResult = await pool.query(
      `UPDATE transfers SET status = $1, completed_at = NOW() WHERE id = $2
       RETURNING id, sender_id, recipient_id, amount, token_symbol, chain, status, completed_at`,
      ["completed", transferId]
    );

    await pool.query("COMMIT");

    const completedTransfer = updatedResult.rows[0];

    // Clear PIN
    inMemoryPINs.delete(`${senderId}:${transferId}`);

    res.json({
      ok: true,
      data: {
        transferId: completedTransfer.id,
        status: completedTransfer.status,
        message: "Transfer completed successfully",
        transfer: completedTransfer,
      },
    });
  } catch (err) {
    console.error("confirmTransfer error", err);
    res.status(500).json({ ok: false, error: "Transfer confirmation failed" });
  }
};

export const transfer = async (req, res) => {
  const senderId = req.user?.id;
  const { recipient, amount, asset } = req.body;
  const idempotencyKey = req.headers["idempotency-key"] || req.headers["Idempotency-Key"] || req.headers["idempotency_key"] || null;

  if (!senderId) {
    return respondError(res, 401, "Not authenticated", false);
  }

  if (req.body.toUserId || req.body.recipientId || req.body.recipientEmail || req.body.recipientPhone) {
    return respondError(res, 400, "Only recipient, amount, and asset are allowed", false);
  }

  if (!recipient || typeof recipient !== 'string' || !recipient.trim()) {
    return respondError(res, 400, "Recipient is required", false);
  }

  const recipientInput = recipient.trim();
  if (!amount) {
    return respondError(res, 400, "Amount is required", false);
  }

  const amountString = String(amount).trim();
  const amountRegex = /^\d+(?:\.\d{1,6})?$/;
  if (!amountRegex.test(amountString) || amountString === '0' || /^0+(?:\.0+)?$/.test(amountString)) {
    return respondError(res, 400, "Amount must be a positive decimal with up to 6 decimals", false);
  }

  if (!asset || typeof asset !== 'string') {
    return respondError(res, 400, "Asset is required", false);
  }

  try {
    const isEmail = recipientInput.includes('@');
    const whereClause = isEmail
      ? { email: recipientInput.toLowerCase() }
      : { phone: recipientInput };

    const receiverUser = await User.findOne({
      where: whereClause,
    });

    if (!receiverUser) {
      return respondError(res, 404, "Recipient not found", false);
    }

    const receiverId = receiverUser.id;
    if (!receiverId || typeof receiverId !== 'string' || receiverId.includes('@')) {
      throw new Error('CRITICAL: receiverId is not a UUID');
    }

    if (senderId === receiverId) {
      return respondError(res, 400, "Cannot transfer to yourself", false);
    }

    const senderAccount = await Account.findOne({
      where: {
        user_id: senderId,
        asset: asset.trim(),
      },
    });

    if (!senderAccount) {
      return respondError(res, 404, "Sender account not found for asset", false);
    }

    console.log("TRANSFER RESOLVED:", {
      senderId,
      receiverId,
      recipientInput,
      typeOfReceiverId: typeof receiverId,
    });

    if (receiverId.includes("@")) {
      throw new Error("CRITICAL: receiverId is not a UUID");
    }

    console.log("FINAL TRANSFER DATA:", {
      senderId: req.user.id,
      receiverId,
      type: typeof receiverId,
    });

    const transferRecord = await transferFunds(senderId, receiverId, amountString, {
      asset: asset.trim(),
      reference: idempotencyKey,
    });

    return res.json({
      success: true,
      transactionId: transferRecord.id,
      amount: amountString,
      toUserId: receiverId,
    });
  } catch (err) {
    console.error("transfer error", err);
    if (err.message === "INSUFFICIENT_FUNDS") {
      return respondError(res, 400, "Insufficient available balance", false);
    }
    if (err.message === "RECEIVER_ACCOUNT_NOT_FOUND" || err.message === "SENDER_ACCOUNT_NOT_FOUND") {
      return respondError(res, 404, "Account not found", false);
    }
    if (err.message === "SELF_TRANSFER_NOT_ALLOWED") {
      return respondError(res, 400, "Cannot transfer to yourself", false);
    }
    if (err.message === "INVALID_AMOUNT") {
      return respondError(res, 400, "Amount must be a positive decimal with up to 6 decimals", false);
    }

    return respondError(res, 500, "Transfer failed", true, err.message);
  }
};

// Get transfer history for a user
export const getTransferHistory = async (req, res) => {
  const userId = req.user?.id;

  if (!userId) {
    return res.status(401).json({ ok: false, error: "Not authenticated" });
  }

  try {
    const result = await pool.query(
      `SELECT
        t.id,
        t.sender_id,
        t.recipient_id,
        t.amount,
        t.token_symbol,
        t.chain,
        t.status,
        t.created_at,
        t.completed_at,
        s.email as sender_email,
        r.email as recipient_email
       FROM transfers t
       LEFT JOIN users s ON t.sender_id = s.id
       LEFT JOIN users r ON t.recipient_id = r.id
       WHERE t.sender_id = $1 OR t.recipient_id = $1
       ORDER BY t.created_at DESC
       LIMIT 100`,
      [userId]
    );

    const sent = result.rows.filter((t) => t.sender_id === userId);
    const received = result.rows.filter((t) => t.recipient_id === userId);

    res.json({
      ok: true,
      data: {
        sent,
        received,
        total: sent.length + received.length,
      },
    });
  } catch (err) {
    console.error("getTransferHistory error", err);
    res.status(500).json({ ok: false, error: "Failed to retrieve history" });
  }
};

function simulateSolanaWithdrawal(toAddress, amount) {
  const txHash = `solana-withdraw-${Date.now()}`;
  return Promise.resolve({ success: true, txHash });
}

export const withdraw = async (req, res) => {
  const userId = req.user?.id;
  const { amount, toAddress, chain = "solana" } = req.body;

  if (!userId) {
    return res.status(401).json({ ok: false, error: "Not authenticated" });
  }

  if (chain !== "solana") {
    return res.status(400).json({ ok: false, error: "Only Solana withdrawals are supported" });
  }

  const withdrawAmount = parseFloat(amount);
  if (!withdrawAmount || withdrawAmount <= 0 || !toAddress) {
    return res.status(400).json({ ok: false, error: "Valid amount and Solana address required" });
  }

  try {
    await pool.query('BEGIN');

    const balanceResult = await pool.query(
      `SELECT available_balance FROM balances WHERE user_id = $1 FOR UPDATE`,
      [userId]
    );
    if (balanceResult.rows.length === 0 || Number(balanceResult.rows[0].available_balance) < withdrawAmount) {
      await pool.query('ROLLBACK');
      return res.status(400).json({ ok: false, error: "Insufficient balance" });
    }

    const transactionResult = await pool.query(
      `INSERT INTO transactions (user_id, type, amount, asset, reference, status)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id`,
      [
        userId,
        'withdrawal',
        withdrawAmount,
        'USDC',
        `withdrawal to ${toAddress}`,
        'pending'
      ]
    );

    await pool.query(
      `UPDATE balances SET available_balance = available_balance - $1 WHERE user_id = $2`,
      [withdrawAmount, userId]
    );

    await pool.query('COMMIT');

    const result = await simulateSolanaWithdrawal(toAddress, withdrawAmount);

    if (!result.success) {
      // Refund
      await pool.query('BEGIN');
      await pool.query(
        `UPDATE balances SET available_balance = available_balance + $1 WHERE user_id = $2`,
        [withdrawAmount, userId]
      );
      await pool.query(
        `UPDATE transactions SET status = $1, tx_hash = $2 WHERE id = $3`,
        ['failed', result.txHash || null, transactionResult.rows[0].id]
      );
      await pool.query('COMMIT');

      return res.status(500).json({ ok: false, error: "Withdrawal broadcast failed", details: result.message || "Transaction failed" });
    }

    await pool.query(
      `UPDATE transactions SET status = $1, tx_hash = $2 WHERE id = $3`,
      ['completed', result.txHash, transactionResult.rows[0].id]
    );

    res.json({
      ok: true,
      data: {
        transactionId: transactionResult.rows[0].id,
        status: 'completed',
        tx_hash: result.txHash,
        message: "Withdrawal completed successfully",
      },
    });
  } catch (err) {
    await pool.query('ROLLBACK');
    console.error("withdraw error", err);
    res.status(500).json({ ok: false, error: "Withdrawal failed" });
  }
};

// Get pending transfers for a recipient
export const getPendingTransfers = async (req, res) => {
  const userId = req.user?.id;

  if (!userId) {
    return res.status(401).json({ ok: false, error: "Not authenticated" });
  }

  try {
    const result = await pool.query(
      `SELECT
        t.id,
        t.sender_id,
        t.amount,
        t.token_symbol,
        t.chain,
        t.status,
        t.created_at,
        s.email as sender_email
       FROM transfers t
       LEFT JOIN users s ON t.sender_id = s.id
       WHERE t.recipient_id = $1 AND t.status != 'completed'
       ORDER BY t.created_at DESC`,
      [userId]
    );

    res.json({
      ok: true,
      data: result.rows,
    });
  } catch (err) {
    console.error("getPendingTransfers error", err);
    res.status(500).json({ ok: false, error: "Failed to retrieve pending transfers" });
  }
};
