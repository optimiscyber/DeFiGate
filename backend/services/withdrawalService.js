import { Connection, PublicKey } from "@solana/web3.js";
import {
  getAssociatedTokenAddress,
  createAssociatedTokenAccountInstruction,
  getAccount,
  transferChecked,
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import axios from "axios";
import pool from "../db.js";
import dotenv from "dotenv";
import { logAuditEvent, AUDIT_ACTIONS } from './auditService.js';

dotenv.config();

const SOLANA_RPC_URL = process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com";
const PRIVY_APP_ID = process.env.PRIVY_APP_ID;
const PRIVY_APP_SECRET = process.env.PRIVY_APP_SECRET;
const PRIVY_BASE = "https://api.privy.io";

const USDC_MINT = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
const USDC_DECIMALS = 6;

// Privy headers
function privyHeaders() {
  const encoded = Buffer.from(`${PRIVY_APP_ID}:${PRIVY_APP_SECRET}`).toString("base64");
  return {
    Authorization: `Basic ${encoded}`,
    "privy-app-id": PRIVY_APP_ID,
    "Content-Type": "application/json",
  };
}

// Resolve Privy wallet ID
async function resolvePrivyWalletId(walletId) {
  const result = await pool.query(
    `SELECT provider_wallet_id FROM wallets WHERE id = $1 OR provider_wallet_id = $1 LIMIT 1`,
    [walletId]
  );
  return result.rows[0]?.provider_wallet_id || null;
}

// Check if transaction is already confirmed on-chain
async function confirmTransaction(txHash, maxRetries = 30) {
  const connection = new Connection(SOLANA_RPC_URL, "confirmed");

  for (let i = 0; i < maxRetries; i++) {
    try {
      const tx = await connection.getTransaction(txHash, {
        commitment: "confirmed",
        maxSupportedTransactionVersion: 0,
      });

      if (tx && tx.meta) {
        return {
          confirmed: true,
          success: tx.meta.err === null,
          slot: tx.slot,
          fee: tx.meta.fee,
        };
      }
    } catch (error) {
      console.log(`Confirmation attempt ${i + 1} failed:`, error.message);
    }

    // Wait 2 seconds between retries
    await new Promise(resolve => setTimeout(resolve, 2000));
  }

  return { confirmed: false, success: false };
}

// Build USDC transfer transaction
async function buildUSDCTransferTransaction(senderPublicKey, recipientAddress, amount) {
  const connection = new Connection(SOLANA_RPC_URL, "confirmed");
  const recipientPublicKey = new PublicKey(recipientAddress);

  // Get sender's ATA
  const senderATA = await getAssociatedTokenAddress(
    USDC_MINT,
    senderPublicKey,
    false,
    TOKEN_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID
  );

  // Get recipient's ATA
  const recipientATA = await getAssociatedTokenAddress(
    USDC_MINT,
    recipientPublicKey,
    false,
    TOKEN_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID
  );

  // Check if recipient ATA exists, create if not
  let needsCreateATA = false;
  try {
    await getAccount(connection, recipientATA);
  } catch (error) {
    needsCreateATA = true;
  }

  const instructions = [];

  // Add create ATA instruction if needed
  if (needsCreateATA) {
    instructions.push(
      createAssociatedTokenAccountInstruction(
        senderPublicKey, // payer
        recipientATA, // ata
        recipientPublicKey, // owner
        USDC_MINT, // mint
        TOKEN_PROGRAM_ID,
        ASSOCIATED_TOKEN_PROGRAM_ID
      )
    );
  }

  // Convert amount to smallest unit
  const transferAmount = Math.floor(parseFloat(amount) * Math.pow(10, USDC_DECIMALS));

  // Add transfer instruction
  instructions.push(
    transferChecked(
      TOKEN_PROGRAM_ID,
      senderATA, // source
      USDC_MINT, // mint
      recipientATA, // destination
      senderPublicKey, // owner
      [], // multiSigners
      transferAmount, // amount
      USDC_DECIMALS // decimals
    )
  );

  return instructions;
}

// Send transaction via Privy
async function sendTransactionViaPrivy(providerWalletId, instructions) {
  const connection = new Connection(SOLANA_RPC_URL, "confirmed");

  // Get wallet details from Privy
  const walletResponse = await axios.get(
    `${PRIVY_BASE}/v1/wallets/${providerWalletId}`,
    { headers: privyHeaders() }
  );
  const walletData = walletResponse.data;

  if (!walletData.address) {
    throw new Error("Wallet address not found");
  }

  const senderPublicKey = new PublicKey(walletData.address);

  // Create transaction
  const transaction = new Transaction();
  transaction.instructions = instructions;
  transaction.feePayer = senderPublicKey;

  // Get recent blockhash
  const { blockhash } = await connection.getLatestBlockhash();
  transaction.recentBlockhash = blockhash;

  // Serialize transaction for Privy
  const serializedTx = transaction.serialize({
    requireAllSignatures: false,
    verifySignatures: false,
  });

  // Send to Privy for signing and broadcasting
  const caip2 = "solana:mainnet";
  const txBody = {
    chain_type: "solana",
    method: "solana_signAndSendTransaction",
    caip2,
    params: {
      transaction: serializedTx.toString("base64"),
    },
  };

  const response = await axios.post(
    `${PRIVY_BASE}/v1/wallets/${providerWalletId}/rpc`,
    txBody,
    { headers: privyHeaders() }
  );

  return response.data;
}

// Main withdrawal function with state machine
export async function processUSDCWithdrawal(userId, walletId, recipientAddress, amount, idempotencyKey) {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // Step 1: Check for existing transaction with same idempotency key
    if (idempotencyKey) {
      const existingTx = await client.query(
        `SELECT id, status, tx_hash FROM transactions
         WHERE user_id = $1 AND idempotency_key = $2 AND type = 'withdrawal'`,
        [userId, idempotencyKey]
      );

      if (existingTx.rows.length > 0) {
        const tx = existingTx.rows[0];
        await client.query('COMMIT');
        return {
          success: true,
          transactionId: tx.id,
          status: tx.status,
          txHash: tx.tx_hash,
          message: `Transaction already exists with status: ${tx.status}`,
        };
      }
    }

    // Step 2: Validate balance and lock funds
    const balanceResult = await client.query(
      `SELECT available_balance FROM balances WHERE user_id = $1 FOR UPDATE`,
      [userId]
    );

    if (balanceResult.rows.length === 0) {
      await client.query('ROLLBACK');
      throw new Error("User balance not found");
    }

    const availableBalance = parseFloat(balanceResult.rows[0].available_balance || 0);
    const withdrawalAmount = parseFloat(amount);

    if (availableBalance < withdrawalAmount) {
      await client.query('ROLLBACK');
      throw new Error("Insufficient balance");
    }

    // Step 3: Create transaction record with pending status
    const transactionResult = await client.query(
      `INSERT INTO transactions
       (user_id, type, amount, asset, status, recipient_address, idempotency_key, reference)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING id`,
      [
        userId,
        'withdrawal',
        withdrawalAmount,
        'USDC',
        'pending',
        recipientAddress,
        idempotencyKey,
        `USDC withdrawal to ${recipientAddress}`,
      ]
    );

    const transactionId = transactionResult.rows[0].id;

    // Step 4: Deduct balance (lock funds)
    await client.query(
      `UPDATE balances SET available_balance = available_balance - $1 WHERE user_id = $2`,
      [withdrawalAmount, userId]
    );

    await client.query('COMMIT');

    // Step 5: Build and send transaction
    try {
      const providerWalletId = await resolvePrivyWalletId(walletId);
      if (!providerWalletId) {
        throw new Error("Invalid wallet identifier");
      }

      // Get wallet address
      const walletResponse = await axios.get(
        `${PRIVY_BASE}/v1/wallets/${providerWalletId}`,
        { headers: privyHeaders() }
      );
      const senderAddress = walletResponse.data.address;

      if (!senderAddress) {
        throw new Error("Wallet address not found");
      }

      const senderPublicKey = new PublicKey(senderAddress);

      // Build transaction instructions
      const instructions = await buildUSDCTransferTransaction(
        senderPublicKey,
        recipientAddress,
        amount
      );

      // Send transaction
      const txResult = await sendTransactionViaPrivy(providerWalletId, instructions);
      const txHash = txResult?.data?.signature || txResult?.signature;

      if (!txHash) {
        throw new Error("Transaction broadcast failed - no signature returned");
      }

      // Step 6: Update status to broadcasted
      await pool.query(
        `UPDATE transactions
         SET status = 'broadcasted', tx_hash = $1, broadcasted_at = NOW()
         WHERE id = $2`,
        [txHash, transactionId]
      );

      // Log audit event
      await logAuditEvent(AUDIT_ACTIONS.WITHDRAWAL_BROADCASTED, {
        user_id: userId,
        transaction_id: transactionId,
        tx_hash: txHash,
        amount: amount,
        asset: 'USDC',
        metadata: {
          recipient_address: recipientAddress,
          wallet_id: walletId
        }
      });

      // Step 7: Confirm transaction asynchronously
      confirmTransaction(txHash).then(async (confirmation) => {
        try {
          if (confirmation.confirmed && confirmation.success) {
            // Success: mark as confirmed
            await pool.query(
              `UPDATE transactions
               SET status = 'confirmed', confirmed_at = NOW(), network_fee = $1
               WHERE id = $2`,
              [confirmation.fee || 0, transactionId]
            );
          } else {
            // Failure: mark as failed and refund
            await pool.query('BEGIN');
            await pool.query(
              `UPDATE balances SET available_balance = available_balance + $1 WHERE user_id = $2`,
              [withdrawalAmount, userId]
            );
            await pool.query(
              `UPDATE transactions
               SET status = 'failed', failed_at = NOW(), failure_reason = $1
               WHERE id = $2`,
              [confirmation.confirmed ? 'Transaction failed on-chain' : 'Transaction confirmation timeout', transactionId]
            );
            await pool.query('COMMIT');
          }
        } catch (error) {
          console.error('Confirmation processing error:', error);
        }
      }).catch(async (error) => {
        console.error('Confirmation error:', error);
        // Mark as failed and refund
        try {
          await pool.query('BEGIN');
          await pool.query(
            `UPDATE balances SET available_balance = available_balance + $1 WHERE user_id = $2`,
            [withdrawalAmount, userId]
          );
          await pool.query(
            `UPDATE transactions
             SET status = 'failed', failed_at = NOW(), failure_reason = $1
             WHERE id = $2`,
            ['Confirmation process failed', transactionId]
          );
          await pool.query('COMMIT');
        } catch (refundError) {
          console.error('Refund error:', refundError);
        }
      });

      return {
        success: true,
        transactionId,
        status: 'broadcasted',
        txHash,
        message: "Withdrawal broadcasted successfully, awaiting confirmation",
      };

    } catch (error) {
      // Transaction failed: refund and mark as failed
      await pool.query('BEGIN');
      await pool.query(
        `UPDATE balances SET available_balance = available_balance + $1 WHERE user_id = $2`,
        [withdrawalAmount, userId]
      );
      await pool.query(
        `UPDATE transactions
         SET status = 'failed', failed_at = NOW(), failure_reason = $1
         WHERE id = $2`,
        [error.message, transactionId]
      );
      await pool.query('COMMIT');

      throw error;
    }

  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

// Get withdrawal status
export async function getWithdrawalStatus(transactionId, userId) {
  const result = await pool.query(
    `SELECT id, status, tx_hash, amount, asset, recipient_address,
            created_at, broadcasted_at, confirmed_at, failed_at, failure_reason, network_fee
     FROM transactions
     WHERE id = $1 AND user_id = $2 AND type = 'withdrawal'`,
    [transactionId, userId]
  );

  if (result.rows.length === 0) {
    throw new Error("Transaction not found");
  }

  return result.rows[0];
}