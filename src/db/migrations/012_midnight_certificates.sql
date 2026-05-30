-- Create midnight_certificates table
CREATE TABLE midnight_certificates (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  cert_id CHAR(64) UNIQUE NOT NULL, -- Cryptographic certificate ID
  county_code VARCHAR(10) NOT NULL,  -- Kenya county code identifier
  period_start DATE NOT NULL,
  period_end DATE NOT NULL,
  condition_type VARCHAR(100) NOT NULL,
  confidence_threshold DECIMAL(4, 3) NOT NULL,
  midnight_tx_hash TEXT,
  issued_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
