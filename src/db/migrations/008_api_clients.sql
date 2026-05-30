-- Create api_clients table
CREATE TABLE api_clients (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  key_hash CHAR(64) UNIQUE NOT NULL, -- SHA-256 hash of API key
  client_name VARCHAR(100) NOT NULL,
  client_email VARCHAR(150) NOT NULL,
  permissions TEXT[] NOT NULL,
  rate_limit_per_hour INTEGER NOT NULL DEFAULT 1000,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  last_used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Index for authentication key lookup
CREATE INDEX idx_api_clients_key_hash ON api_clients (key_hash);
