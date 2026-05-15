import bcrypt from "bcrypt";
import crypto from "crypto";
import pool from "../db.js";
import { generateToken } from "../middleware/auth.js";
import { ensureUserWallet, getCanonicalWallet } from "./walletController.js";
import { sendVerificationEmail } from "../services/emailService.js";
import { respondError, respondSuccess } from "../utils/response.js";
import Balance from "../models/Balance.js";
import Account from "../models/Account.js";
import Transaction from "../models/Transaction.js";

function normalizeEmail(email) {
  return String(email || "").trim().toLowerCase();
}

function generateVerificationToken() {
  return crypto.randomBytes(24).toString("hex");
}

async function getWalletForUser(userId) {
  const result = await pool.query(
    `SELECT id, user_id, provider, provider_wallet_id, address, chain, created_at, last_accessed_at, is_primary
     FROM wallets WHERE user_id = $1 LIMIT 1`,
    [userId]
  );
  return result.rows[0] || null;
}

export const signup = async (req, res) => {
  const { email, password, name, walletAddress, phone, company } = req.body;
  const normalizedEmail = normalizeEmail(email);

  if (!normalizedEmail || !password || password.length < 6) {
    return respondError(res, 400, "Email and password (min 6 chars) are required", false);
  }

  const verificationToken = generateVerificationToken();
  const preferredChain = "solana";

  try {
    const hash = await bcrypt.hash(password, 10);
    const result = await pool.query(
      `INSERT INTO users (email, password_hash, name, wallet_address, phone, company, is_verified, email_verification_token, kyc_status, preferred_chain, role)
       VALUES ($1, $2, $3, $4, $5, $6, false, $7, 'pending', $8, 'user')
       RETURNING id, email, name, wallet_address, phone, company, is_verified, kyc_status, preferred_chain, role`,
      [normalizedEmail, hash, name || null, walletAddress || null, phone || null, company || null, verificationToken, preferredChain]
    );

    const user = result.rows[0];
    
    // Mark user as verified immediately (skip verification step for dev)
    await pool.query(
      `UPDATE users SET is_verified = true WHERE id = $1`,
      [user.id]
    );
    user.is_verified = true;

    // Create balance record with zero starting funds (legacy)
    try {
      await Balance.create({
        user_id: user.id,
        available_balance: 0.0,
      });
    } catch (err) {
      console.error("Balance creation error", err);
      // Continue, but log
    }

    // Create Account records for both USDC and SOL
    try {
      await Account.findOrCreate({
        where: { user_id: user.id, asset: 'USDC' },
        defaults: { available_balance: 0, pending_balance: 0 }
      });
      await Account.findOrCreate({
        where: { user_id: user.id, asset: 'SOL' },
        defaults: { available_balance: 0, pending_balance: 0 }
      });
    } catch (err) {
      console.error("Account creation error", err);
      // Continue, but log
    }

    let wallet;
    try {
      wallet = await ensureUserWallet(user.id, user.email, preferredChain);
    } catch (err) {
      console.error("DB signup wallet error", err?.message || err);
      wallet = { status: "disconnected", error: err?.message || "Wallet create failed" };
    }

    const token = generateToken(user);
    return respondSuccess(res, {
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        walletAddress: user.wallet_address,
        phone: user.phone,
        company: user.company,
        is_verified: user.is_verified,
        kyc_status: user.kyc_status,
        available_balance: 0.0,
        role: user.role || 'user',
        wallet,
      },
      token,
    }, "Account created and authenticated");
  } catch (err) {
    console.error("DB signup error", err);
    // Handle Sequelize unique constraint errors
    if (err.name === "SequelizeUniqueConstraintError") {
      const field = err.errors?.[0]?.path || "field";
      return respondError(res, 409, `User already exists with this ${field}`, false);
    }
    // Handle raw PostgreSQL unique constraint
    if (err.code === "23505") {
      return respondError(res, 409, "User already exists with this email or wallet", false);
    }
    return respondError(res, 500, "Account creation failed", true, err.message);
  }
};

export const signin = async (req, res) => {
  const { email, password } = req.body;
  const normalizedEmail = normalizeEmail(email);

  if (!normalizedEmail || !password) {
    return respondError(res, 400, "Email and password required", false);
  }

  try {
    const result = await pool.query(
      `SELECT id, email, name, wallet_address, phone, company, password_hash, is_verified, kyc_status, preferred_chain, role
       FROM users WHERE email = $1`,
      [normalizedEmail]
    );

    if (result.rows.length === 0) {
      return respondError(res, 404, "Account not found. Please sign up first.", false);
    }

    const user = result.rows[0];
    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) {
      return respondError(res, 401, "Invalid credentials", false);
    }

    // Get balance
    const balanceResult = await pool.query(`SELECT available_balance FROM balances WHERE user_id = $1`, [user.id]);
    const available_balance = balanceResult.rows[0]?.available_balance || 0;

    let wallet;
    try {
      wallet = await getCanonicalWallet(user.id, user.preferred_chain || "solana");
      if (!wallet) {
        wallet = { status: "disconnected", error: "Wallet not found" };
      }
    } catch (err) {
      console.error("DB signin wallet error", err?.message || err);
      wallet = { status: "disconnected", error: err?.message || "Wallet lookup failed" };
    }

    const token = generateToken(user);
    return respondSuccess(res, {
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        walletAddress: user.wallet_address,
        phone: user.phone,
        company: user.company,
        available_balance: available_balance,
        is_verified: user.is_verified,
        kyc_status: user.kyc_status,
        role: user.role || 'user',
        wallet,
      },
      token,
    });
  } catch (err) {
    console.error("DB signin error", err?.message || err);
    return respondError(res, 500, "Sign in failed", true, err.message);
  }
};

export const verifyEmail = async (req, res) => {
  const { token } = req.body;
  if (!token) {
    return respondError(res, 400, "Verification token is required", false);
  }

  try {
    const result = await pool.query(
      `UPDATE users
       SET is_verified = true,
           email_verification_token = NULL,
           email_verified_at = NOW()
       WHERE email_verification_token = $1
       RETURNING id, email, is_verified`,
      [token]
    );

    if (result.rows.length === 0) {
      return respondError(res, 404, "Verification token invalid or expired", false);
    }

    return respondSuccess(res, {
      user: result.rows[0],
    }, "Email verified successfully");
  } catch (err) {
    console.error("verifyEmail error", err);
    return respondError(res, 500, "Verification failed", true, err.message);
  }
};

export const resendVerification = async (req, res) => {
  const { email } = req.body;
  const normalizedEmail = normalizeEmail(email);

  if (!normalizedEmail) {
    return respondError(res, 400, "Email is required", false);
  }

  try {
    const userResult = await pool.query(
      `SELECT id, email, is_verified FROM users WHERE email = $1`,
      [normalizedEmail]
    );
    if (userResult.rows.length === 0) {
      return respondError(res, 404, "User not found", false);
    }
    const user = userResult.rows[0];
    if (user.is_verified) {
      return respondError(res, 400, "Email is already verified", false);
    }
    const newToken = generateVerificationToken();
    await pool.query(
      `UPDATE users SET email_verification_token = $1 WHERE email = $2`,
      [newToken, normalizedEmail]
    );
    const emailResponse = await sendVerificationEmail(normalizedEmail, newToken);
    return respondSuccess(res, { verificationEmail: emailResponse.verificationUrl }, "Verification email resent.");
  } catch (err) {
    console.error("resendVerification error", err);
    return respondError(res, 500, "Unable to resend verification email", true, err.message);
  }
};

export const signout = async (req, res) => {
  return respondSuccess(res, {}, "Signed out successfully");
};

export const topup = async (req, res) => {
  const { amount } = req.body;
  const userId = req.user.id;

  if (!amount || amount <= 0) {
    return respondError(res, 400, "Valid amount is required", false);
  }

  try {
    await pool.query('BEGIN');
    const balanceResult = await pool.query(
      `SELECT available_balance FROM balances WHERE user_id = $1 FOR UPDATE`,
      [userId]
    );
    if (balanceResult.rows.length === 0) {
      await pool.query('ROLLBACK');
      return respondError(res, 404, "Balance not found", false);
    }
    const currentBalance = parseFloat(balanceResult.rows[0].available_balance);
    const newBalance = currentBalance + parseFloat(amount);
    await pool.query(
      `UPDATE balances SET available_balance = $1 WHERE user_id = $2`,
      [newBalance, userId]
    );
    await pool.query(
      `INSERT INTO transactions (user_id, type, amount, asset, status, reference)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [userId, 'deposit', amount, 'USDC', 'completed', 'topup']
    );
    await pool.query('COMMIT');
    return respondSuccess(res, { balance: newBalance }, "Topup successful");
  } catch (err) {
    await pool.query('ROLLBACK');
    console.error("topup error", err);
    return respondError(res, 500, "Unable to process topup", true, err.message);
  }
};

export const updateProfile = async (req, res) => {
  const user = req.user;
  const { name, phone, company } = req.body;

  try {
    const result = await pool.query(
      `UPDATE users SET name = COALESCE($1, name), phone = COALESCE($2, phone), company = COALESCE($3, company), updated_at = NOW()
       WHERE id = $4
       RETURNING id, email, name, wallet_address, phone, company`,
      [name, phone, company, user.id]
    );

    if (result.rows.length === 0) {
      return respondError(res, 404, "User not found", false);
    }

    const updatedUser = result.rows[0];
    return respondSuccess(res, {
      user: {
        id: updatedUser.id,
        email: updatedUser.email,
        name: updatedUser.name,
        walletAddress: updatedUser.wallet_address,
        phone: updatedUser.phone,
        company: updatedUser.company,
      },
    }, "Profile updated");
  } catch (err) {
    console.error("updateProfile error", err);
    return respondError(res, 500, "Profile update failed", true, err.message);
  }
};

export const changePassword = async (req, res) => {
  const user = req.user;
  const { currentPassword, newPassword } = req.body;

  if (!currentPassword || !newPassword || newPassword.length < 6) {
    return respondError(res, 400, "Current password and new password (min 6 chars) required", false);
  }

  try {
    const result = await pool.query(
      `SELECT password_hash FROM users WHERE id = $1`,
      [user.id]
    );

    if (result.rows.length === 0) {
      return respondError(res, 404, "User not found", false);
    }

    const valid = await bcrypt.compare(currentPassword, result.rows[0].password_hash);
    if (!valid) {
      return respondError(res, 401, "Current password incorrect", false);
    }

    const hash = await bcrypt.hash(newPassword, 10);
    await pool.query(
      `UPDATE users SET password_hash = $1, updated_at = NOW() WHERE id = $2`,
      [hash, user.id]
    );

    return respondSuccess(res, {}, "Password changed");
  } catch (err) {
    console.error("changePassword error", err);
    return respondError(res, 500, "Password change failed", true, err.message);
  }
};

export const enable2FA = async (req, res) => {
  const user = req.user;

  // For simplicity, just set a flag. In real app, integrate with 2FA library.
  try {
    await pool.query(
      `UPDATE users SET two_fa_enabled = true, updated_at = NOW() WHERE id = $1`,
      [user.id]
    );
    return respondSuccess(res, { two_fa_enabled: true }, "2FA enabled");
  } catch (err) {
    console.error("enable2FA error", err);
    return respondError(res, 500, "2FA enable failed", true, err.message);
  }
};

export const getTransactions = async (req, res) => {
  const user = req.user;

  try {
    // Get transactions from the transactions table
    const transactionsResult = await pool.query(
      `SELECT id, type, amount, asset, status, tx_hash, reference, recipient_address, created_at, broadcasted_at, confirmed_at, failed_at, failure_reason, network_fee, 'transaction'::text AS direction
       FROM transactions
       WHERE user_id = $1
       ORDER BY created_at DESC`,
      [user.id]
    );

    // Get transfers from the transfers table
    const transfersResult = await pool.query(
      `SELECT 'transfer_' || id AS id,
              'transfer' AS type,
              amount,
              'USDC' AS asset,
              'completed'::text AS status,
              NULL AS tx_hash,
              NULL AS reference,
              NULL AS recipient_address,
              created_at,
              created_at AS broadcasted_at,
              NULL AS confirmed_at,
              NULL AS failed_at,
              NULL AS failure_reason,
              NULL AS network_fee,
              CASE WHEN sender_id = $1 THEN 'outgoing' ELSE 'incoming' END AS direction
       FROM transfers
       WHERE sender_id = $1 OR receiver_id = $1
       ORDER BY created_at DESC`,
      [user.id]
    );

    // Combine and sort all transactions
    const allTransactions = [...transactionsResult.rows, ...transfersResult.rows]
      .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

    return respondSuccess(res, { transactions: allTransactions }, "Transactions retrieved");
  } catch (err) {
    console.error("getTransactions error", err);
    return respondError(res, 500, "Failed to retrieve transactions", true, err.message);
  }
};

export const getBalances = async (req, res) => {
  const user = req.user;

  try {
    const balancesResult = await pool.query(
      `SELECT asset, available_balance, pending_balance, updated_at
       FROM balances
       WHERE user_id = $1`,
      [user.id]
    );

    if (balancesResult.rows.length > 0) {
      return respondSuccess(res, { balances: balancesResult.rows }, "Balances retrieved");
    }

    // Return default assets when no balances exist yet
    return respondSuccess(res, {
      balances: [
        { asset: 'USDC', available_balance: 0, pending_balance: 0, updated_at: null },
        { asset: 'SOL', available_balance: 0, pending_balance: 0, updated_at: null },
      ],
    }, "Balances retrieved");
  } catch (err) {
    console.error("getBalances error", err);
    return respondError(res, 500, "Failed to retrieve balances", true, err.message);
  }
};

export const getMe = async (req, res) => {
  const user = req.user;
  if (!user) {
    return res.status(401).json({ ok: false, error: "Not authenticated" });
  }

  try {
    const result = await pool.query(
      `SELECT u.id, u.email, u.is_verified, u.role, b.available_balance
       FROM users u
       LEFT JOIN balances b ON u.id = b.user_id
       WHERE u.id = $1`,
      [user.id]
    );
    if (result.rows.length === 0) {
      return res.status(401).json({ ok: false, error: "User not found" });
    }
    const fullUser = result.rows[0];

    let wallet;
    try {
      wallet = await getCanonicalWallet(fullUser.id, "solana");
      if (!wallet) {
        wallet = { status: "disconnected", error: "Wallet not found" };
      }
    } catch (err) {
      console.error("getMe wallet error", err?.message || err);
      wallet = { status: "disconnected", error: err?.message || "Wallet lookup failed" };
    }

    res.json({
      ok: true,
      data: {
        user: {
          id: fullUser.id,
          email: fullUser.email,
          role: fullUser.role || 'user',
          available_balance: Number(fullUser.available_balance || 0),
          is_verified: fullUser.is_verified,
          wallet,
        },
      },
    });
  } catch (err) {
    console.error("getMe error", err);
    return respondError(res, 500, "Failed to get user data", true, err.message);
  }
};
