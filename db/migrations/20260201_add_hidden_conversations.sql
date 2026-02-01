-- Add table to track hidden conversations (one-sided deletion)
CREATE TABLE IF NOT EXISTS hidden_conversations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    other_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    hidden_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE(user_id, other_user_id)
);

-- Index for faster lookups
CREATE INDEX IF NOT EXISTS idx_hidden_conversations_user_id ON hidden_conversations(user_id);
CREATE INDEX IF NOT EXISTS idx_hidden_conversations_other_user_id ON hidden_conversations(other_user_id);

COMMENT ON TABLE hidden_conversations IS 'Tracks which users have hidden conversations with other users (one-sided deletion)';
