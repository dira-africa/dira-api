-- Create agent_profiles table
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
