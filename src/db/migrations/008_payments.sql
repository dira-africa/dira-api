-- Create custom enums for redemptions
CREATE TYPE redemption_type AS ENUM ('airtime', 'voucher', 'circle', 'mpesa');
CREATE TYPE redemption_status AS ENUM ('pending', 'processing', 'completed', 'failed');

-- Create payment_requests table
CREATE TABLE payment_requests (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  amount_kes DECIMAL(10, 2) NOT NULL,
  phone_number TEXT NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'pending', -- 'pending', 'approved', 'rejected'
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Create payment_transactions table
CREATE TABLE payment_transactions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  payment_request_id UUID REFERENCES payment_requests(id) ON DELETE SET NULL,
  transaction_reference VARCHAR(100) UNIQUE,
  amount_kes DECIMAL(10, 2) NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'pending', -- 'pending', 'completed', 'failed'
  receipt_number VARCHAR(50),
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Create legacy redemption_requests table for backwards compatibility
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

-- Create mpesa_activation_settings table
CREATE TABLE mpesa_activation_settings (
  key VARCHAR(50) PRIMARY KEY,
  value BOOLEAN NOT NULL DEFAULT FALSE,
  updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

-- Seed initial checklist items
INSERT INTO mpesa_activation_settings (key, value) VALUES
  ('daraja_credentials_approved', FALSE),
  ('first_b2b_revenue_received', FALSE)
ON CONFLICT DO NOTHING;
