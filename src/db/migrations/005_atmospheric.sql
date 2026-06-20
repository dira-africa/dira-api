-- Create atmospheric_verification_status enum
CREATE TYPE atmospheric_verification_status AS ENUM ('pending', 'verified', 'rejected', 'manual_review', 'escalated');

-- Create atmospheric_readings table
CREATE TABLE atmospheric_readings (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  location GEOMETRY(Point, 4326) NOT NULL,
  pressure_hpa DECIMAL(8, 2) NOT NULL,
  altitude_m DECIMAL(6, 1) NOT NULL,
  temperature_c DECIMAL(4, 1) NOT NULL,
  humidity_pct DECIMAL(4, 1) NOT NULL,
  recorded_at TIMESTAMPTZ NOT NULL,
  verified BOOLEAN NOT NULL DEFAULT FALSE,
  anomaly_score DECIMAL(4, 3) NOT NULL DEFAULT 0.000,
  openmeteo_reference_hpa DECIMAL(8, 2),
  network_consensus BOOLEAN NOT NULL DEFAULT FALSE,
  verification_status atmospheric_verification_status NOT NULL DEFAULT 'pending',
  admin_notes TEXT,
  escalated_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Spatial and relational indexes
CREATE INDEX idx_atmospheric_readings_location ON atmospheric_readings USING GIST (location);
CREATE INDEX idx_atmospheric_readings_recorded_at ON atmospheric_readings (recorded_at DESC);
CREATE INDEX idx_atmospheric_readings_user_id ON atmospheric_readings (user_id);

-- Create atmospheric_triangulations table
CREATE TABLE atmospheric_triangulations (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  reading_id UUID NOT NULL REFERENCES atmospheric_readings(id) ON DELETE CASCADE,
  triangulated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  reference_readings_count INTEGER NOT NULL,
  variance_hpa DECIMAL(8, 4) NOT NULL
);
