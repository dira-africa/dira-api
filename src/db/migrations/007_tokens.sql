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

-- Create climate_tokens table
CREATE TABLE climate_tokens (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID UNIQUE NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  balance INTEGER NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Attach trigger to climate_tokens
CREATE TRIGGER update_climate_tokens_updated_at
BEFORE UPDATE ON climate_tokens
FOR EACH ROW
EXECUTE FUNCTION update_updated_at_column();

-- Create token_transactions table
CREATE TABLE token_transactions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  amount INTEGER NOT NULL,
  type VARCHAR(50) NOT NULL, -- 'credit', 'debit'
  reference_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Create legacy token_ledger table for backwards compatibility
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
