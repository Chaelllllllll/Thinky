-- Add columns for message moderation (warnings and mute state)
ALTER TABLE IF EXISTS users
  ADD COLUMN IF NOT EXISTS message_warning_count integer DEFAULT 0,
  ADD COLUMN IF NOT EXISTS message_warning_first_at timestamptz DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS message_muted_until timestamptz DEFAULT NULL;

CREATE INDEX IF NOT EXISTS idx_users_message_muted_until ON users (message_muted_until);
CREATE INDEX IF NOT EXISTS idx_users_message_warning_first_at ON users (message_warning_first_at);
