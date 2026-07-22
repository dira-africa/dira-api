-- Add columns for Bayesian verification score, contributing factors, and perceptual hash
ALTER TABLE crop_submissions ADD COLUMN IF NOT EXISTS verification_score NUMERIC(5, 4) DEFAULT 0.0;
ALTER TABLE crop_submissions ADD COLUMN IF NOT EXISTS verification_factors JSONB DEFAULT '{}'::jsonb;
ALTER TABLE crop_submissions ADD COLUMN IF NOT EXISTS perceptual_hash CHAR(16);

-- Add index for perceptual hash lookup
CREATE INDEX IF NOT EXISTS idx_crop_submissions_perceptual_hash ON crop_submissions(perceptual_hash);

-- Create verification_calibration_logs table to track score vs actual verification outcome
CREATE TABLE IF NOT EXISTS verification_calibration_logs (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  submission_id UUID NOT NULL REFERENCES crop_submissions(id) ON DELETE CASCADE,
  predicted_probability NUMERIC(5, 4) NOT NULL,
  eventual_outcome VARCHAR(20) CHECK (eventual_outcome IN ('verified', 'rejected')),
  logged_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_verification_calibration_logged_at ON verification_calibration_logs(logged_at DESC);
