-- Create followers table
CREATE TABLE IF NOT EXISTS followers (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    follower_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    following_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    UNIQUE(follower_id, following_id),
    CHECK (follower_id != following_id)
);

-- Create indexes for efficient queries
CREATE INDEX idx_followers_follower_id ON followers(follower_id);
CREATE INDEX idx_followers_following_id ON followers(following_id);
CREATE INDEX idx_followers_created_at ON followers(created_at DESC);

-- Create index for notification cleanup by date
CREATE INDEX IF NOT EXISTS idx_notifications_created_at ON notifications(created_at DESC);

-- Add follower_count and following_count to users table (denormalized for performance)
ALTER TABLE users ADD COLUMN IF NOT EXISTS follower_count INTEGER DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS following_count INTEGER DEFAULT 0;

-- Function to update follower counts
CREATE OR REPLACE FUNCTION update_follower_counts()
RETURNS TRIGGER AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        -- Increment following_count for follower
        UPDATE users SET following_count = following_count + 1 WHERE id = NEW.follower_id;
        -- Increment follower_count for following
        UPDATE users SET follower_count = follower_count + 1 WHERE id = NEW.following_id;
    ELSIF TG_OP = 'DELETE' THEN
        -- Decrement following_count for follower
        UPDATE users SET following_count = GREATEST(0, following_count - 1) WHERE id = OLD.follower_id;
        -- Decrement follower_count for following
        UPDATE users SET follower_count = GREATEST(0, follower_count - 1) WHERE id = OLD.following_id;
    END IF;
    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

-- Create trigger for follower counts
DROP TRIGGER IF EXISTS trigger_update_follower_counts ON followers;
CREATE TRIGGER trigger_update_follower_counts
AFTER INSERT OR DELETE ON followers
FOR EACH ROW
EXECUTE FUNCTION update_follower_counts();

-- Initialize existing counts
UPDATE users SET follower_count = (
    SELECT COUNT(*) FROM followers WHERE following_id = users.id
);
UPDATE users SET following_count = (
    SELECT COUNT(*) FROM followers WHERE follower_id = users.id
);

-- Grant permissions
GRANT SELECT, INSERT, DELETE ON followers TO anon;
GRANT SELECT, INSERT, DELETE ON followers TO authenticated;

-- Add RLS policies for followers
ALTER TABLE followers ENABLE ROW LEVEL SECURITY;

-- Anyone can view follows
CREATE POLICY "Anyone can view follows" ON followers
    FOR SELECT USING (true);

-- Users can follow others (insert their own follows)
CREATE POLICY "Users can follow others" ON followers
    FOR INSERT WITH CHECK (auth.uid() = follower_id);

-- Users can unfollow (delete their own follows)
CREATE POLICY "Users can unfollow" ON followers
    FOR DELETE USING (auth.uid() = follower_id);

-- Comments
COMMENT ON TABLE followers IS 'User following relationships';
COMMENT ON COLUMN followers.follower_id IS 'User who is following';
COMMENT ON COLUMN followers.following_id IS 'User being followed';
