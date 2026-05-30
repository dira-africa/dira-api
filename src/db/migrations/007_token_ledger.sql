-- Create transaction_type enum
CREATE TYPE transaction_type AS ENUM (
  'atmospheric_sync',
  'crop_photo',
  'redeem_airtime',
  'redeem_voucher',
  'redeem_circle',
  'redeem_mpesa',
  'bonus',
  'adjustment'
);

-- Create token_ledger table
CREATE TABLE token_ledger (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  amount INTEGER NOT NULL, -- Negative for debits/redemptions, positive for credits/rewards
  balance_after INTEGER NOT NULL,
  transaction_type transaction_type NOT NULL,
  reference_id UUID, -- Links to submissions or redemptions
  notes VARCHAR(255),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT chk_positive_balance CHECK (balance_after >= 0)
);

-- Index for user ledger queries
CREATE INDEX idx_token_ledger_user_created ON token_ledger (user_id, created_at DESC);
