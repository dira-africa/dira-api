-- Add appeal support to crop submissions
-- Part of R6 Procedural Justice: transparency, reasons & appeals

ALTER TABLE crop_submissions ADD COLUMN IF NOT EXISTS is_appealed BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE crop_submissions ADD COLUMN IF NOT EXISTS appeal_reason TEXT;
ALTER TABLE crop_submissions ADD COLUMN IF NOT EXISTS appealed_at TIMESTAMPTZ;
