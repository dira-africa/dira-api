-- Create zkverify_anchors table
CREATE TABLE zkverify_anchors (
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

-- Create batch_contents table
CREATE TABLE batch_contents (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  anchor_id UUID NOT NULL REFERENCES zkverify_anchors(id) ON DELETE CASCADE,
  reading_id UUID NOT NULL REFERENCES atmospheric_readings(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
