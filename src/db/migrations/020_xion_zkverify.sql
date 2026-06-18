-- Create xion_anchors table
CREATE TABLE xion_anchors (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  week_number INTEGER UNIQUE NOT NULL,
  batch_hash CHAR(64) NOT NULL, -- SHA-256 batch hash of anchored data
  data_point_count INTEGER NOT NULL,
  xion_tx_hash TEXT,
  zkverify_proof_id TEXT,
  zkverify_tx_hash TEXT,
  anchored_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Create xion_certificates table
CREATE TABLE xion_certificates (
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
