-- =====================================================
-- PERFORMANCE OPTIMIZATION INDEXES
-- Run this migration to improve query performance
-- =====================================================

-- Composite indexes for common query patterns
-- Messages: frequently filtered by chat_type + created_at + recipient_id
CREATE INDEX IF NOT EXISTS idx_messages_chat_type_created_at 
    ON messages(chat_type, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_messages_recipient_created_at 
    ON messages(recipient_id, created_at DESC) 
    WHERE recipient_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_messages_user_recipient 
    ON messages(user_id, recipient_id) 
    WHERE chat_type = 'private';

-- Reviewers: public + created_at is very common
CREATE INDEX IF NOT EXISTS idx_reviewers_public_created_at 
    ON reviewers(is_public, created_at DESC) 
    WHERE is_public = true;

-- Partial index for active/unresolved reports
CREATE INDEX IF NOT EXISTS idx_reviewer_reports_open 
    ON reviewer_reports(created_at DESC) 
    WHERE status = 'open' OR status IS NULL;

CREATE INDEX IF NOT EXISTS idx_chat_reports_open 
    ON chat_reports(created_at DESC) 
    WHERE status = 'open' OR status IS NULL;

-- Index for reactions lookups (heart counts)
CREATE INDEX IF NOT EXISTS idx_reactions_reviewer_type 
    ON reactions(reviewer_id, reaction_type);

-- Sessions table optimization (if using Postgres sessions)
CREATE INDEX IF NOT EXISTS idx_session_expire_sid 
    ON session(expire, sid);

-- Email verifications - lookup by email
CREATE INDEX IF NOT EXISTS idx_email_verifications_email_expires 
    ON email_verifications(email, expires_at DESC) 
    WHERE used = false;

-- Password resets - lookup by email
CREATE INDEX IF NOT EXISTS idx_password_resets_email_expires 
    ON password_resets(email, expires_at DESC) 
    WHERE used = false;

-- User lookups by banned_until (for moderation checks)
CREATE INDEX IF NOT EXISTS idx_users_banned 
    ON users(banned_until) 
    WHERE banned_until IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_users_muted 
    ON users(chat_muted_until) 
    WHERE chat_muted_until IS NOT NULL;

-- =====================================================
-- ANALYZE TABLES (update query planner statistics)
-- =====================================================
ANALYZE messages;
ANALYZE reviewers;
ANALYZE users;
ANALYZE reviewer_reports;
ANALYZE chat_reports;
ANALYZE reactions;
