-- Create data_agents table
CREATE TABLE data_agents (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID UNIQUE NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_model VARCHAR(100),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Create agent_certifications table
CREATE TABLE agent_certifications (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  agent_id UUID NOT NULL REFERENCES data_agents(id) ON DELETE CASCADE,
  certification_name VARCHAR(100) NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  certified_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at TIMESTAMPTZ
);

-- Create certification_history table
CREATE TABLE certification_history (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  agent_id UUID NOT NULL REFERENCES data_agents(id) ON DELETE CASCADE,
  action VARCHAR(50) NOT NULL, -- e.g. 'granted', 'revoked', 'expired'
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Create legacy agent_profiles table for backwards compatibility
CREATE TABLE agent_profiles (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  coverage_center GEOMETRY(Point, 4326) NOT NULL,
  coverage_radius_km DECIMAL(5, 2) NOT NULL,
  device_model VARCHAR(100),
  is_certified BOOLEAN NOT NULL DEFAULT FALSE,
  certified_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Spatial index on legacy agent_profiles
CREATE INDEX idx_agent_profiles_center ON agent_profiles USING GIST (coverage_center);
