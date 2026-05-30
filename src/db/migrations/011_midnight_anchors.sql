-- Create midnight_anchors table
CREATE TABLE midnight_anchors (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  week_number INTEGER UNIQUE NOT NULL,
  batch_hash CHAR(64) NOT NULL, -- SHA-256 batch hash of anchored data
  data_point_count INTEGER NOT NULL,
  midnight_tx_hash TEXT,
  anchored_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
