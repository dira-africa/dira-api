-- Alter users table to support suspension details
ALTER TABLE users ADD COLUMN suspension_reason TEXT;
ALTER TABLE users ADD COLUMN suspended_at TIMESTAMPTZ;

-- Alter verification_status enum to add 'escalated' value
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 
    FROM pg_enum e 
    JOIN pg_type t ON e.enumtypid = t.oid 
    WHERE t.typname = 'verification_status' AND e.enumlabel = 'escalated'
  ) THEN
    ALTER TYPE verification_status ADD VALUE 'escalated';
  END IF;
END
$$;

-- Alter crop_submissions to add admin notes
ALTER TABLE crop_submissions ADD COLUMN admin_notes TEXT;
ALTER TABLE crop_submissions ADD COLUMN escalated_at TIMESTAMPTZ;

-- Alter atmospheric_readings to add verification status and admin notes
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'atmospheric_verification_status') THEN
    CREATE TYPE atmospheric_verification_status AS ENUM ('pending', 'verified', 'rejected', 'manual_review', 'escalated');
  END IF;
END
$$;

ALTER TABLE atmospheric_readings ADD COLUMN verification_status atmospheric_verification_status NOT NULL DEFAULT 'pending';
ALTER TABLE atmospheric_readings ADD COLUMN admin_notes TEXT;
ALTER TABLE atmospheric_readings ADD COLUMN escalated_at TIMESTAMPTZ;
