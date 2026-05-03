-- Ensure transaction hashes are unique to prevent duplicate deposit processing
ALTER TABLE transactions
  ADD CONSTRAINT unique_transaction_hash UNIQUE (tx_hash);
