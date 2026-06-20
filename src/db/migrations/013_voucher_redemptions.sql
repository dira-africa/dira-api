-- Create voucher_redemptions table
CREATE TABLE voucher_redemptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  farmer_id UUID REFERENCES farmers(id),
  agro_dealer_id UUID NOT NULL, -- FK constraint added in migration 015
  token_amount DECIMAL(10,2) NOT NULL,
  kes_value DECIMAL(10,2) NOT NULL,
  voucher_code VARCHAR(64) NOT NULL UNIQUE,
  voucher_qr_hash VARCHAR(128) NOT NULL,
  expires_at TIMESTAMPTZ,
  scanned_at TIMESTAMPTZ,
  reconciled_at TIMESTAMPTZ,
  status VARCHAR(20) DEFAULT 'pending',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Create agro_dealer_reconciliations table
CREATE TABLE agro_dealer_reconciliations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agro_dealer_id UUID, -- FK constraint added in migration 015
  period_start DATE NOT NULL,
  period_end DATE NOT NULL,
  total_tokens_redeemed DECIMAL(10,2),
  total_kes_owed DECIMAL(10,2),
  settlement_reference VARCHAR(100),
  settled_at TIMESTAMPTZ,
  status VARCHAR(20) DEFAULT 'pending'
);
