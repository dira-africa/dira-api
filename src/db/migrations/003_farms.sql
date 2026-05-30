-- Create farms table
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
