-- Add withdrawal state machine and idempotency support
-- Migration: 010_add_withdrawal_state_machine.sql

-- Add new status values to transactions table
ALTER TABLE transactions DROP CONSTRAINT IF EXISTS transactions_status_check;
ALTER TABLE transactions ADD CONSTRAINT transactions_status_check
    CHECK (status IN ('pending', 'broadcasted', 'confirmed', 'failed', 'completed'));

-- Add idempotency key and additional fields for withdrawal state machine
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS idempotency_key TEXT UNIQUE;
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS broadcasted_at TIMESTAMP WITH TIME ZONE;
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS confirmed_at TIMESTAMP WITH TIME ZONE;
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS failed_at TIMESTAMP WITH TIME ZONE;
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS failure_reason TEXT;
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS recipient_address TEXT;
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS network_fee DECIMAL(20, 6) DEFAULT 0;

-- Create index for idempotency key lookups
CREATE INDEX IF NOT EXISTS idx_transactions_idempotency_key ON transactions(idempotency_key) WHERE idempotency_key IS NOT NULL;

-- Create index for status-based queries
CREATE INDEX IF NOT EXISTS idx_transactions_status_updated ON transactions(status, created_at DESC);

-- Add constraint to ensure only withdrawals have recipient_address
ALTER TABLE transactions ADD CONSTRAINT check_withdrawal_address
    CHECK ((type = 'withdrawal' AND recipient_address IS NOT NULL) OR (type != 'withdrawal' AND recipient_address IS NULL));