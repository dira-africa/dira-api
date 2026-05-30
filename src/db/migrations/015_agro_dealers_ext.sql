-- Add dealer_logo_url column to agro_dealers table
ALTER TABLE agro_dealers ADD COLUMN dealer_logo_url TEXT;

-- Create dealer_product_categories table
CREATE TABLE dealer_product_categories (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  dealer_id UUID NOT NULL REFERENCES agro_dealers(id) ON DELETE CASCADE,
  category_name VARCHAR(100) NOT NULL, -- e.g. seeds, fertilizer, crop-protection
  is_active BOOLEAN NOT NULL DEFAULT TRUE
);

-- Index for product queries
CREATE INDEX idx_dealer_product_categories_dealer ON dealer_product_categories (dealer_id);
