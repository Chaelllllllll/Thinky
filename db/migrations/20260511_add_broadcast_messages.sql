-- =====================================================
-- BROADCAST MESSAGES TABLE FOR DELETION TRACKING
-- =====================================================

CREATE TABLE IF NOT EXISTS broadcast_messages (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    admin_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    message TEXT NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Track which messages are part of this broadcast
CREATE TABLE IF NOT EXISTS broadcast_message_mappings (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    broadcast_id UUID NOT NULL REFERENCES broadcast_messages(id) ON DELETE CASCADE,
    message_id UUID NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Indexes for fast lookups
CREATE INDEX idx_broadcast_messages_admin_id ON broadcast_messages(admin_id);
CREATE INDEX idx_broadcast_messages_created_at ON broadcast_messages(created_at DESC);
CREATE INDEX idx_broadcast_message_mappings_broadcast_id ON broadcast_message_mappings(broadcast_id);
CREATE INDEX idx_broadcast_message_mappings_message_id ON broadcast_message_mappings(message_id);
