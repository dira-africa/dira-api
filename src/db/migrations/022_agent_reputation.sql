-- Create agent_reputations table for unified reputation tracking
CREATE TABLE IF NOT EXISTS agent_reputations (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID UNIQUE NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  alpha NUMERIC(8, 4) NOT NULL DEFAULT 2.0,
  beta NUMERIC(8, 4) NOT NULL DEFAULT 2.0,
  trust_score NUMERIC(5, 4) NOT NULL DEFAULT 0.5000,
  trust_tier VARCHAR(20) NOT NULL DEFAULT 'new' CHECK (trust_tier IN ('new', 'trusted', 'flagged')),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_agent_reputations_user_id ON agent_reputations(user_id);
CREATE INDEX IF NOT EXISTS idx_agent_reputations_trust_tier ON agent_reputations(trust_tier);

-- Create agent_reputation_logs table for auditability and history tracking
CREATE TABLE IF NOT EXISTS agent_reputation_logs (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  old_alpha NUMERIC(8, 4) NOT NULL,
  old_beta NUMERIC(8, 4) NOT NULL,
  new_alpha NUMERIC(8, 4) NOT NULL,
  new_beta NUMERIC(8, 4) NOT NULL,
  old_trust_score NUMERIC(5, 4) NOT NULL,
  new_trust_score NUMERIC(5, 4) NOT NULL,
  old_trust_tier VARCHAR(20) NOT NULL,
  new_trust_tier VARCHAR(20) NOT NULL,
  submission_id UUID,
  submission_type VARCHAR(30) CHECK (submission_type IN ('crop', 'atmospheric')),
  outcome VARCHAR(20) CHECK (outcome IN ('success', 'failure')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_agent_reputation_logs_user_id ON agent_reputation_logs(user_id);
CREATE INDEX IF NOT EXISTS idx_agent_reputation_logs_created_at ON agent_reputation_logs(created_at DESC);
