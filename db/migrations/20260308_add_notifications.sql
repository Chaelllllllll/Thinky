-- =====================================================
-- NOTIFICATIONS SYSTEM
-- =====================================================

-- Create notifications table
CREATE TABLE IF NOT EXISTS notifications (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    type VARCHAR(50) NOT NULL CHECK (type IN ('reaction', 'comment', 'message', 'reply', 'follow')),
    title TEXT NOT NULL,
    message TEXT NOT NULL,
    link TEXT NOT NULL,
    related_user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    related_item_id UUID,
    is_read BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Create indexes for efficient querying
CREATE INDEX IF NOT EXISTS idx_notifications_user_id ON notifications(user_id);
CREATE INDEX IF NOT EXISTS idx_notifications_is_read ON notifications(is_read);
CREATE INDEX IF NOT EXISTS idx_notifications_created_at ON notifications(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_notifications_user_unread ON notifications(user_id, is_read, created_at DESC);

-- Add comment
COMMENT ON TABLE notifications IS 'Stores user notifications for reactions, comments, and messages';
COMMENT ON COLUMN notifications.type IS 'Type of notification: reaction, comment, message, or reply';
COMMENT ON COLUMN notifications.related_user_id IS 'The user who triggered this notification';
COMMENT ON COLUMN notifications.related_item_id IS 'The ID of the related item (reviewer, comment, message, etc.)';

-- Grant permissions
GRANT ALL ON notifications TO postgres, authenticated, service_role;
