-- Alter zkverify_anchors table to support weekly batch proof fields
ALTER TABLE zkverify_anchors ALTER COLUMN week_number DROP NOT NULL;
ALTER TABLE zkverify_anchors ALTER COLUMN batch_hash DROP NOT NULL;
ALTER TABLE zkverify_anchors ALTER COLUMN data_point_count DROP NOT NULL;

-- Add new columns for the zkVerify aggregation receipt
ALTER TABLE zkverify_anchors ADD COLUMN IF NOT EXISTS domain_id INTEGER;
ALTER TABLE zkverify_anchors ADD COLUMN IF NOT EXISTS aggregation_id TEXT;
ALTER TABLE zkverify_anchors ADD COLUMN IF NOT EXISTS merkle_root TEXT;
ALTER TABLE zkverify_anchors ADD COLUMN IF NOT EXISTS statement TEXT;
