-- Create mpesa_activation_settings table
CREATE TABLE mpesa_activation_settings (
  key VARCHAR(50) PRIMARY KEY,
  value BOOLEAN NOT NULL DEFAULT FALSE,
  updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

-- Seed initial checklist items
INSERT INTO mpesa_activation_settings (key, value) VALUES
  ('daraja_credentials_approved', FALSE),
  ('first_b2b_revenue_received', FALSE)
ON CONFLICT DO NOTHING;
