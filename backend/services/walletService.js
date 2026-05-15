import pool from "../db.js";
import { Wallet } from "../models/index.js";

export async function warnIfDuplicateWallets(userId, chainType = "solana") {
  const countResult = await pool.query(
    `SELECT COUNT(*) AS count
     FROM wallets
     WHERE user_id = $1 AND chain = $2`,
    [userId, chainType]
  );
  const count = parseInt(countResult.rows?.[0]?.count || "0", 10);
  if (count > 1) {
    console.warn(
      `Wallet warning: user ${userId} has ${count} wallets for chain ${chainType}. Using canonical wallet only.`
    );
  }
}

export async function getCanonicalWallet(userId, chainType = "solana") {
  if (!userId) return null;

  const wallet = await Wallet.findOne({
    where: { user_id: userId, chain: chainType },
    order: [
      ["is_primary", "DESC"],
      ["created_at", "ASC"],
    ],
  });

  if (!wallet) {
    return null;
  }

  await warnIfDuplicateWallets(userId, chainType);
  return wallet;
}

export async function getCanonicalWalletByWalletId(walletId) {
  if (!walletId) return null;
  const wallet = await Wallet.findByPk(walletId);
  if (!wallet) return null;
  const canonical = await getCanonicalWallet(wallet.user_id, wallet.chain || "solana");
  if (canonical && canonical.id !== wallet.id) {
    console.error(
      `Wallet fallback: requested wallet ${wallet.id} but using canonical wallet ${canonical.id} for user ${canonical.user_id}.`
    );
  }
  return canonical;
}

export async function getAllCanonicalWallets(chainType = "solana") {
  const duplicateRows = await pool.query(
    `SELECT user_id, COUNT(*) AS count
     FROM wallets
     WHERE chain = $1
     GROUP BY user_id
     HAVING COUNT(*) > 1`,
    [chainType]
  );

  for (const row of duplicateRows.rows) {
    console.warn(
      `Wallet warning: user ${row.user_id} has ${row.count} wallets for chain ${chainType}. Using canonical wallet only.`
    );
  }

  const rows = await pool.query(
    `SELECT DISTINCT ON (user_id) id
     FROM wallets
     WHERE chain = $1
     ORDER BY user_id, is_primary DESC, created_at ASC`,
    [chainType]
  );
  const ids = rows.rows.map((r) => r.id);
  if (ids.length === 0) {
    return [];
  }

  return await Wallet.findAll({
    where: { id: ids },
    order: [["user_id", "ASC"]],
  });
}
