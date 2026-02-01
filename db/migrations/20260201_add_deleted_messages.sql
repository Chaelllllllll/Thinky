-- Add table to track deleted messages (soft-delete for "delete for you")
CREATE TABLE IF NOT EXISTS deleted_messages (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    message_id UUID NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    deleted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE(user_id, message_id)
);

-- Index for faster lookups
CREATE INDEX IF NOT EXISTS idx_deleted_messages_user_id ON deleted_messages(user_id);
CREATE INDEX IF NOT EXISTS idx_deleted_messages_message_id ON deleted_messages(message_id);

COMMENT ON TABLE deleted_messages IS 'Tracks which users have deleted which messages (one-sided soft deletion)';
