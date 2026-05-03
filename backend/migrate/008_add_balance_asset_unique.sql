-- Add asset support and stronger balance constraints to balances
ALTER TABLE balances
  ADD COLUMN IF NOT EXISTS asset VARCHAR(50) NOT NULL DEFAULT 'USDC';

UPDATE balances
  SET asset = 'USDC'
  WHERE asset IS NULL;

ALTER TABLE balances
  DROP CONSTRAINT IF EXISTS balances_user_id_key;

ALTER TABLE balances
  ADD CONSTRAINT IF NOT EXISTS unique_user_asset UNIQUE (user_id, asset);

ALTER TABLE balances
  ADD CONSTRAINT IF NOT EXISTS chk_available_balance_nonnegative CHECK (available_balance >= 0);
