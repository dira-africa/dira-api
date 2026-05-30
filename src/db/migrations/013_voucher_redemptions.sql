-- Create agro_dealers table
CREATE TABLE agro_dealers (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  dealer_name VARCHAR(120) NOT NULL,
  dealer_phone VARCHAR(20) UNIQUE NOT NULL,
  county_id VARCHAR(50) NOT NULL,
  mou_signed_at TIMESTAMPTZ,
  bank_account TEXT NOT NULL,
  reconciliation_day_of_week VARCHAR(15) NOT NULL DEFAULT 'Friday',
  transaction_fee_pct DECIMAL(4, 2) NOT NULL DEFAULT 3.50,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Create voucher_redemptions table
CREATE TABLE voucher_redemptions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  farmer_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  agro_dealer_id UUID NOT NULL REFERENCES agro_dealers(id) ON DELETE CASCADE,
  token_amount INTEGER NOT NULL,
  kes_value DECIMAL(10, 2) NOT NULL,
  voucher_code VARCHAR(50) UNIQUE NOT NULL,
  voucher_qr_hash TEXT,
  expires_at TIMESTAMPTZ NOT NULL,
  scanned_at TIMESTAMPTZ,
  reconciled_at TIMESTAMPTZ,
  status VARCHAR(20) NOT NULL DEFAULT 'active', -- 'active', 'scanned', 'reconciled', 'expired'
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Create agro_dealer_reconciliations table
CREATE TABLE agro_dealer_reconciliations (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  agro_dealer_id UUID NOT NULL REFERENCES agro_dealers(id) ON DELETE CASCADE,
  period_start DATE NOT NULL,
  period_end DATE NOT NULL,
  total_tokens INTEGER NOT NULL,
  total_kes_owed DECIMAL(12, 2) NOT NULL,
  settlement_reference VARCHAR(100),
  settled_at TIMESTAMPTZ,
  status VARCHAR(20) NOT NULL DEFAULT 'pending' -- 'pending', 'settled'
);

-- Index optimizations
CREATE INDEX idx_voucher_redemptions_code ON voucher_redemptions (voucher_code);
CREATE INDEX idx_agro_dealer_reconciliations_dealer ON agro_dealer_reconciliations (agro_dealer_id);
