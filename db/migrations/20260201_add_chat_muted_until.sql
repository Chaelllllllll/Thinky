-- Add dedicated field for chat muting separate from full bans and content creation restrictions
-- This allows proper distinction between:
-- - chat_muted_until: temporary restriction from sending chat messages
-- - banned_until: full account ban (cannot login/access platform)
-- - blocked_from_creating_until: restriction from creating reviewer content

ALTER TABLE users
    ADD COLUMN IF NOT EXISTS chat_muted_until TIMESTAMP WITH TIME ZONE DEFAULT NULL;

CREATE INDEX IF NOT EXISTS idx_users_chat_muted_until ON users (chat_muted_until);

COMMENT ON COLUMN users.chat_muted_until IS 'Temporary restriction from sending chat messages (mute)';
COMMENT ON COLUMN users.banned_until IS 'Full account ban - user cannot access the platform';
COMMENT ON COLUMN users.blocked_from_creating_until IS 'Restriction from creating reviewer content';
