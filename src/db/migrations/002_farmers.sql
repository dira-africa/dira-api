-- Create farmers table
CREATE TABLE farmers (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID UNIQUE NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Attach trigger to farmers table
CREATE TRIGGER update_farmers_updated_at
BEFORE UPDATE ON farmers
FOR EACH ROW
EXECUTE FUNCTION update_updated_at_column();

-- Create farmer_profiles table
CREATE TABLE farmer_profiles (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  farmer_id UUID NOT NULL REFERENCES farmers(id) ON DELETE CASCADE,
  farm_size_acres DECIMAL(8, 2),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Attach trigger to farmer_profiles table
CREATE TRIGGER update_farmer_profiles_updated_at
BEFORE UPDATE ON farmer_profiles
FOR EACH ROW
EXECUTE FUNCTION update_updated_at_column();

-- Create crop_types table
CREATE TABLE crop_types (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name VARCHAR(100) UNIQUE NOT NULL,
  description TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Create farm_boundaries table
CREATE TABLE farm_boundaries (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  farmer_id UUID NOT NULL REFERENCES farmers(id) ON DELETE CASCADE,
  boundary GEOMETRY(Polygon, 4326) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Attach trigger to farm_boundaries table
CREATE TRIGGER update_farm_boundaries_updated_at
BEFORE UPDATE ON farm_boundaries
FOR EACH ROW
EXECUTE FUNCTION update_updated_at_column();

-- Spatial index on farm_boundaries
CREATE INDEX idx_farm_boundaries_boundary ON farm_boundaries USING GIST (boundary);

-- Create legacy farms table for backwards compatibility
CREATE TABLE farms (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  farm_location GEOMETRY(Point, 4326) NOT NULL,
  farm_size_acres DECIMAL(8, 2) NOT NULL,
  crop_types TEXT[] NOT NULL,
  county VARCHAR(60) NOT NULL,
  sub_county VARCHAR(60) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Attach trigger to farms table
CREATE TRIGGER update_farms_updated_at
BEFORE UPDATE ON farms
FOR EACH ROW
EXECUTE FUNCTION update_updated_at_column();

-- Spatial index on legacy farms
CREATE INDEX idx_farms_location ON farms USING GIST (farm_location);
