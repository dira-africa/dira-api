-- Add alerts configuration and log tables for farmers climate warning alerts
-- Part of R5 Farmer Climate Alerts

-- Add alert preference column to users table
ALTER TABLE users ADD COLUMN IF NOT EXISTS alerts_enabled BOOLEAN NOT NULL DEFAULT TRUE;

-- Create farmer climate alerts log table
CREATE TABLE IF NOT EXISTS farmer_climate_alerts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    metric VARCHAR(50) NOT NULL,
    probability_estimate INT NOT NULL,
    credible_interval_low DOUBLE PRECISION NOT NULL,
    credible_interval_high DOUBLE PRECISION NOT NULL,
    confidence_level VARCHAR(20) NOT NULL,
    protective_action VARCHAR(255) NOT NULL,
    escalation_trigger VARCHAR(255) NOT NULL,
    message TEXT NOT NULL,
    status VARCHAR(20) NOT NULL, -- 'sent', 'rate_limited', 'opted_out'
    sent_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

-- Optimize rate limit check queries
CREATE INDEX IF NOT EXISTS idx_farmer_climate_alerts_user_sent_at 
ON farmer_climate_alerts(user_id, sent_at DESC NULLS LAST);
