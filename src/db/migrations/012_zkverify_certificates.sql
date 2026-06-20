-- Create zkverify_certificates table
CREATE TABLE zkverify_certificates (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  cert_id CHAR(64) UNIQUE NOT NULL, -- Cryptographic certificate ID
  county_code VARCHAR(10) NOT NULL,  -- Kenya county code identifier
  period_start DATE NOT NULL,
  period_end DATE NOT NULL,
  condition_type VARCHAR(100) NOT NULL,
  confidence_threshold DECIMAL(4, 3) NOT NULL,
  xion_tx_hash TEXT,
  zkverify_proof_id TEXT,
  zkverify_tx_hash TEXT,
  issued_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Create certificate_verifications table
CREATE TABLE certificate_verifications (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  certificate_id UUID NOT NULL REFERENCES zkverify_certificates(id) ON DELETE CASCADE,
  verification_receipt TEXT NOT NULL,
  verified_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
