-- Create early warning thresholds register and alerts log tables
-- Part of R4 Early-Warning System

CREATE TABLE IF NOT EXISTS early_warning_thresholds (
    metric VARCHAR(50) PRIMARY KEY,
    threshold_value DOUBLE PRECISION NOT NULL,
    protective_action VARCHAR(255) NOT NULL,
    owner_name VARCHAR(100) NOT NULL,
    current_status VARCHAR(20) DEFAULT 'normal',
    last_value DOUBLE PRECISION DEFAULT 0.0,
    updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS early_warning_alerts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    metric VARCHAR(50) NOT NULL,
    threshold_value DOUBLE PRECISION NOT NULL,
    current_value DOUBLE PRECISION NOT NULL,
    status VARCHAR(20) NOT NULL,
    message TEXT NOT NULL,
    signature VARCHAR(256) NOT NULL,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

-- Pre-seed default configuration thresholds
INSERT INTO early_warning_thresholds (metric, threshold_value, protective_action, owner_name, current_status, last_value)
VALUES
    ('verification_failure_rate', 0.30, 'Inspect Gemini model logs and check AI fallback configurations', 'Alice (AI Lead)', 'normal', 0.05),
    ('airtime_balance', 200.0, 'Pause automatic disbursements and flag low-float manual warning', 'Bob (Operations Lead)', 'normal', 5000.0),
    ('queue_backlog', 50.0, 'Scale up background job workers concurrency', 'Charlie (Infrastructure)', 'normal', 0.0),
    ('mirror_node_lag', 60.0, 'Fallback public queries to local PG cache and inspect mirror node RPC', 'David (Blockchain Specialist)', 'normal', 2.5),
    ('api_error_rate', 0.10, 'Enable request rate limiters and inspect web server access logs', 'Alice (AI Lead)', 'normal', 0.01),
    ('agent_submission_cadence', 14400.0, 'Send reminder push alerts to inactive weather agents', 'Bob (Operations Lead)', 'normal', 3600.0)
ON CONFLICT (metric) DO NOTHING;
