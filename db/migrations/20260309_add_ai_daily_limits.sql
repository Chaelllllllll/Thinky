-- =====================================================
-- AI Daily Usage Limits
-- =====================================================

-- Track per-user, per-type AI usage per UTC day
CREATE TABLE IF NOT EXISTS ai_usage_log (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    usage_type VARCHAR(20) NOT NULL CHECK (usage_type IN ('reviewer', 'quiz')),
    used_date DATE NOT NULL DEFAULT CURRENT_DATE,
    count INTEGER NOT NULL DEFAULT 1,
    UNIQUE (user_id, usage_type, used_date)
);

CREATE INDEX IF NOT EXISTS idx_ai_usage_log_user_date ON ai_usage_log (user_id, used_date);

-- Flag to exempt a user from the daily AI limit (set by admin)
ALTER TABLE users
    ADD COLUMN IF NOT EXISTS ai_limit_exempt BOOLEAN DEFAULT FALSE;
