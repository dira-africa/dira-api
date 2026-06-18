-- Alter users table to add DPA 2019 compliance fields
ALTER TABLE users ADD COLUMN IF NOT EXISTS privacy_policy_accepted_at TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS delete_requested_at TIMESTAMPTZ;
