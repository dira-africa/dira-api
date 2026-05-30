-- Create verification_status enum
CREATE TYPE verification_status AS ENUM ('pending', 'verified', 'rejected', 'manual_review');

-- Create crop_submissions table
CREATE TABLE crop_submissions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  farm_id UUID NOT NULL REFERENCES farms(id) ON DELETE CASCADE,
  photo_url TEXT NOT NULL,
  photo_thumbnail_url TEXT,
  location GEOMETRY(Point, 4326) NOT NULL,
  crop_type VARCHAR(100) NOT NULL,
  growth_stage VARCHAR(100) NOT NULL,
  ai_health_score DECIMAL(4, 3) NOT NULL,
  ai_detected_issues JSONB DEFAULT '{}'::jsonb,
  ai_confidence DECIMAL(4, 3) NOT NULL,
  ai_report_en TEXT,
  ai_report_sw TEXT,
  verification_status verification_status NOT NULL DEFAULT 'pending',
  rejection_reason TEXT,
  submitted_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  verified_at TIMESTAMPTZ
);

-- Spatial and relational indexes
CREATE INDEX idx_crop_submissions_location ON crop_submissions USING GIST (location);
CREATE INDEX idx_crop_submissions_submitted_at ON crop_submissions (submitted_at DESC);
CREATE INDEX idx_crop_submissions_user_id ON crop_submissions (user_id);
