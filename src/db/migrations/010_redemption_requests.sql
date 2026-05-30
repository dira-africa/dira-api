-- Create custom enums for redemptions
CREATE TYPE redemption_type AS ENUM ('airtime', 'voucher', 'circle', 'mpesa');
CREATE TYPE redemption_status AS ENUM ('pending', 'processing', 'completed', 'failed');

-- Create redemption_requests table
CREATE TABLE redemption_requests (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tokens_spent INTEGER NOT NULL,
  redemption_type redemption_type NOT NULL,
  amount_kes DECIMAL(10, 2) NOT NULL,
  phone_number TEXT NOT NULL, -- Encrypted phone number
  at_transaction_id VARCHAR(100), -- Africa's Talking transaction ID
  mpesa_receipt VARCHAR(50),      -- Safaricom M-Pesa receipt
  status redemption_status NOT NULL DEFAULT 'pending',
  failure_reason TEXT,
  initiated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completed_at TIMESTAMPTZ
);

-- Index for scanning active cashouts
CREATE INDEX idx_redemption_requests_status ON redemption_requests (status, redemption_type);
CREATE INDEX idx_redemption_requests_user ON redemption_requests (user_id);
