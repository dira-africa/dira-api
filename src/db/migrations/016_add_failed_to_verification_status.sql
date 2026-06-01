-- Alter verification_status enum to add 'failed' value
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 
    FROM pg_enum e 
    JOIN pg_type t ON e.enumtypid = t.oid 
    WHERE t.typname = 'verification_status' AND e.enumlabel = 'failed'
  ) THEN
    ALTER TYPE verification_status ADD VALUE 'failed';
  END IF;
END
$$;
