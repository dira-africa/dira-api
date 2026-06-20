-- Create agro_dealers table
CREATE TABLE agro_dealers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  dealer_name VARCHAR(200) NOT NULL,
  dealer_phone VARCHAR(15) NOT NULL UNIQUE,
  county_id UUID REFERENCES counties(id),
  mou_signed_at TIMESTAMPTZ,
  bank_account VARCHAR(50),
  active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  dealer_logo_url TEXT
);

-- Create dealer_mou_records table
CREATE TABLE dealer_mou_records (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  dealer_id UUID NOT NULL REFERENCES agro_dealers(id) ON DELETE CASCADE,
  mou_text TEXT NOT NULL,
  signed_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  valid_until TIMESTAMPTZ
);

-- Create dealer_weekly_settlements table
CREATE TABLE dealer_weekly_settlements (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  dealer_id UUID NOT NULL REFERENCES agro_dealers(id) ON DELETE CASCADE,
  settlement_date DATE NOT NULL,
  amount_settled DECIMAL(12, 2) NOT NULL,
  payment_method VARCHAR(50) NOT NULL DEFAULT 'bank',
  reference_number VARCHAR(100) UNIQUE NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Create dealer_product_categories table
CREATE TABLE dealer_product_categories (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  dealer_id UUID NOT NULL REFERENCES agro_dealers(id) ON DELETE CASCADE,
  category_name VARCHAR(100) NOT NULL, -- e.g. seeds, fertilizer, crop-protection
  is_active BOOLEAN NOT NULL DEFAULT TRUE
);

-- Add foreign key constraints to voucher_redemptions and agro_dealer_reconciliations
ALTER TABLE voucher_redemptions 
  ADD CONSTRAINT fk_voucher_redemptions_agro_dealer 
  FOREIGN KEY (agro_dealer_id) REFERENCES agro_dealers(id) ON DELETE CASCADE;

ALTER TABLE agro_dealer_reconciliations 
  ADD CONSTRAINT fk_agro_dealer_reconciliations_agro_dealer 
  FOREIGN KEY (agro_dealer_id) REFERENCES agro_dealers(id) ON DELETE CASCADE;

-- Index optimizations
CREATE INDEX idx_voucher_redemptions_code ON voucher_redemptions (voucher_code);
CREATE INDEX idx_agro_dealer_reconciliations_dealer ON agro_dealer_reconciliations (agro_dealer_id);
CREATE INDEX idx_dealer_product_categories_dealer ON dealer_product_categories (dealer_id);
