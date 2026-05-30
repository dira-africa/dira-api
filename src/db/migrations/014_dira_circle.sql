-- Create circle_coordinators table
CREATE TABLE circle_coordinators (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  agent_id UUID UNIQUE NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  county_id VARCHAR(50) UNIQUE NOT NULL, -- Managed county identifier
  mpesa_number TEXT NOT NULL,
  active_from DATE NOT NULL,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Create dira_circle_distributions table
CREATE TABLE dira_circle_distributions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  county_id VARCHAR(50) NOT NULL,
  coordinator_id UUID NOT NULL REFERENCES circle_coordinators(id) ON DELETE CASCADE,
  period_month DATE NOT NULL,
  total_users INTEGER NOT NULL,
  total_tokens INTEGER NOT NULL,
  total_kes_disbursed DECIMAL(12, 2) NOT NULL,
  transfer_reference VARCHAR(100),
  transferred_at TIMESTAMPTZ,
  distribution_confirmed_at TIMESTAMPTZ,
  status VARCHAR(20) NOT NULL DEFAULT 'pending' -- 'pending', 'transferred', 'confirmed'
);

-- Index optimizations
CREATE INDEX idx_dira_circle_distributions_month ON dira_circle_distributions (period_month);
CREATE INDEX idx_dira_circle_distributions_county ON dira_circle_distributions (county_id);
