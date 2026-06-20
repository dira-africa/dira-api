-- Create circle_coordinators table
CREATE TABLE circle_coordinators (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id UUID UNIQUE NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  county_id UUID UNIQUE NOT NULL REFERENCES counties(id) ON DELETE CASCADE, -- Managed county identifier
  mpesa_number TEXT NOT NULL,
  active_from DATE NOT NULL,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Create dira_circle_distributions table
CREATE TABLE dira_circle_distributions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  county_id UUID NOT NULL REFERENCES counties(id) ON DELETE CASCADE,
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
