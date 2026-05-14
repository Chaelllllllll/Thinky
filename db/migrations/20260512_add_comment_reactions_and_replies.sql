-- Rename content column to comment in post_comments
ALTER TABLE post_comments
RENAME COLUMN content TO comment;

-- Add reply_to column to post_comments
ALTER TABLE post_comments
ADD COLUMN IF NOT EXISTS reply_to UUID REFERENCES post_comments(id) ON DELETE CASCADE;

CREATE TABLE IF NOT EXISTS post_comment_reactions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    comment_id UUID NOT NULL REFERENCES post_comments(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    reaction_type VARCHAR(50) DEFAULT 'heart',
    created_at TIMESTAMP DEFAULT NOW(),
    UNIQUE(comment_id, user_id, reaction_type)
);

-- Create indexes
CREATE INDEX IF NOT EXISTS idx_post_comment_reactions_comment_id ON post_comment_reactions(comment_id);
CREATE INDEX IF NOT EXISTS idx_post_comment_reactions_user_id ON post_comment_reactions(user_id);
CREATE INDEX IF NOT EXISTS idx_post_comments_reply_to ON post_comments(reply_to);
