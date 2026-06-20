-- Create circle_coordinators table
CREATE TABLE circle_coordinators (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id UUID REFERENCES data_agents(id),
  county_id UUID REFERENCES counties(id) UNIQUE,
  selected_by_community BOOLEAN DEFAULT TRUE,
  active_from TIMESTAMPTZ DEFAULT NOW(),
  mpesa_number VARCHAR(15),
  active BOOLEAN DEFAULT TRUE
);

-- Create dira_circle_distributions table
CREATE TABLE dira_circle_distributions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  county_id UUID REFERENCES counties(id),
  coordinator_id UUID REFERENCES circle_coordinators(id),
  period_month DATE NOT NULL,
  total_users_requesting INTEGER DEFAULT 0,
  total_tokens_redeemed DECIMAL(10,2),
  total_kes_disbursed DECIMAL(10,2),
  transfer_reference VARCHAR(100),
  transferred_at TIMESTAMPTZ,
  distribution_confirmed_at TIMESTAMPTZ,
  status VARCHAR(20) DEFAULT 'pending'
);

-- Create county_cash_pools table
CREATE TABLE county_cash_pools (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  county_id UUID UNIQUE NOT NULL REFERENCES counties(id) ON DELETE CASCADE,
  balance_kes DECIMAL(12, 2) NOT NULL DEFAULT 0.00,
  updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

-- Index optimizations
CREATE INDEX idx_dira_circle_distributions_month ON dira_circle_distributions (period_month);
CREATE INDEX idx_dira_circle_distributions_county ON dira_circle_distributions (county_id);
