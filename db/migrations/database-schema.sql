-- =====================================================
-- REVIEWER APP - COMPLETE DATABASE SCHEMA
-- =====================================================

-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- =====================================================
-- USERS TABLE
-- =====================================================
CREATE TABLE IF NOT EXISTS users (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    email VARCHAR(255) UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    username VARCHAR(100) UNIQUE NOT NULL,
    role VARCHAR(20) DEFAULT 'student' CHECK (role IN ('student', 'admin')),
    is_verified BOOLEAN DEFAULT FALSE,
    verification_token TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);
-- New fields for user profile
ALTER TABLE users
    ADD COLUMN IF NOT EXISTS display_name VARCHAR(255),
    ADD COLUMN IF NOT EXISTS profile_picture_url TEXT;

-- Create index on email for faster lookups
CREATE INDEX idx_users_email ON users(email);
CREATE INDEX idx_users_username ON users(username);
CREATE INDEX idx_users_role ON users(role);

-- =====================================================
-- SUBJECTS TABLE
-- =====================================================
CREATE TABLE IF NOT EXISTS subjects (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name VARCHAR(255) NOT NULL,
    description TEXT,
    school UUID,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Create indexes
CREATE INDEX idx_subjects_user_id ON subjects(user_id);
CREATE INDEX idx_subjects_created_at ON subjects(created_at DESC);
CREATE INDEX idx_subjects_school ON subjects(school);

-- =====================================================
-- REVIEWERS TABLE
-- =====================================================
CREATE TABLE IF NOT EXISTS reviewers (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    subject_id UUID NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
    title VARCHAR(255) NOT NULL,
    content TEXT NOT NULL,
    is_public BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Create indexes
CREATE INDEX idx_reviewers_user_id ON reviewers(user_id);
CREATE INDEX idx_reviewers_subject_id ON reviewers(subject_id);
CREATE INDEX idx_reviewers_created_at ON reviewers(created_at DESC);
CREATE INDEX idx_reviewers_public ON reviewers(is_public);

-- =====================================================
-- MESSAGES TABLE (Chat System)
-- =====================================================
CREATE TABLE IF NOT EXISTS messages (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    recipient_id UUID REFERENCES users(id) ON DELETE CASCADE,
    username VARCHAR(100) NOT NULL,
    message TEXT NOT NULL,
    chat_type VARCHAR(20) DEFAULT 'general' CHECK (chat_type IN ('general', 'online', 'private')),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Create indexes
CREATE INDEX idx_messages_user_id ON messages(user_id);
CREATE INDEX idx_messages_chat_type ON messages(chat_type);
CREATE INDEX idx_messages_created_at ON messages(created_at DESC);
CREATE INDEX idx_messages_recipient_id ON messages(recipient_id);

-- =====================================================
-- EMAIL VERIFICATIONS TABLE
-- Stores one-time verification codes sent to emails for account verification
-- =====================================================
CREATE TABLE IF NOT EXISTS email_verifications (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    email VARCHAR(255) NOT NULL,
    token VARCHAR(128) NOT NULL,
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    used BOOLEAN DEFAULT FALSE,
    expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX idx_email_verifications_email ON email_verifications(email);
CREATE UNIQUE INDEX idx_email_verifications_token ON email_verifications(token);

-- =====================================================
-- PASSWORD RESETS TABLE
-- Stores password reset tokens sent to emails
-- =====================================================
CREATE TABLE IF NOT EXISTS password_resets (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    email VARCHAR(255) NOT NULL,
    token VARCHAR(128) NOT NULL,
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    used BOOLEAN DEFAULT FALSE,
    expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX idx_password_resets_email ON password_resets(email);
CREATE UNIQUE INDEX idx_password_resets_token ON password_resets(token);

-- =====================================================
-- ONLINE USERS TABLE
-- =====================================================
CREATE TABLE IF NOT EXISTS online_users (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    username VARCHAR(100) NOT NULL,
    last_seen TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    UNIQUE(user_id)
);

-- Create index
CREATE INDEX idx_online_users_last_seen ON online_users(last_seen DESC);

-- =====================================================
-- ROW LEVEL SECURITY (RLS) POLICIES
-- =====================================================

-- Enable RLS on all tables
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE subjects ENABLE ROW LEVEL SECURITY;
ALTER TABLE reviewers ENABLE ROW LEVEL SECURITY;
ALTER TABLE messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE online_users ENABLE ROW LEVEL SECURITY;
ALTER TABLE email_verifications ENABLE ROW LEVEL SECURITY;

-- Users table policies
CREATE POLICY "Users can view all users" ON users
    FOR SELECT USING (true);

CREATE POLICY "Users can update own profile" ON users
    FOR UPDATE USING ((select auth.uid()) = id);

-- Subjects table policies
CREATE POLICY "Anyone can view subjects" ON subjects
    FOR SELECT USING (true);

CREATE POLICY "Users can insert own subjects" ON subjects
    FOR INSERT WITH CHECK ((select auth.uid()) = user_id);

CREATE POLICY "Users can update own subjects" ON subjects
    FOR UPDATE USING ((select auth.uid()) = user_id);

CREATE POLICY "Users can delete own subjects" ON subjects
    FOR DELETE USING ((select auth.uid()) = user_id);

-- Reviewers table policies
CREATE POLICY "Anyone can view public reviewers" ON reviewers
    FOR SELECT USING (is_public = true);

CREATE POLICY "Users can view own reviewers" ON reviewers
    FOR SELECT USING ((select auth.uid()) = user_id);

CREATE POLICY "Users can insert own reviewers" ON reviewers
    FOR INSERT WITH CHECK ((select auth.uid()) = user_id);

CREATE POLICY "Users can update own reviewers" ON reviewers
    FOR UPDATE USING ((select auth.uid()) = user_id);

CREATE POLICY "Users can delete own reviewers" ON reviewers
    FOR DELETE USING ((select auth.uid()) = user_id);

-- Messages table policies
-- Allow selects for non-private chats to everyone, and for private chats only to participants
CREATE POLICY "Users can view messages when allowed" ON messages
    FOR SELECT
    USING (
        chat_type != 'private' OR (select auth.uid()) = user_id OR (select auth.uid()) = recipient_id
    );

CREATE POLICY "Authenticated users can insert messages" ON messages
    FOR INSERT
    WITH CHECK ((select auth.uid()) = user_id);

-- Allow delete for message owner
CREATE POLICY "Users can delete own messages" ON messages
    FOR DELETE USING ((select auth.uid()) = user_id);

-- Online users table policies
CREATE POLICY "Anyone can view online users" ON online_users
    FOR SELECT USING (true);

CREATE POLICY "Users can insert own online status" ON online_users
    FOR INSERT WITH CHECK ((select auth.uid()) = user_id);

CREATE POLICY "Users can update own online status" ON online_users
    FOR UPDATE USING ((select auth.uid()) = user_id);

CREATE POLICY "Users can delete own online status" ON online_users
    FOR DELETE USING ((select auth.uid()) = user_id);

-- =====================================================
-- FUNCTIONS AND TRIGGERS
-- =====================================================

-- Function to update updated_at timestamp
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public, pg_catalog
AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$;

-- Triggers for updated_at
CREATE TRIGGER update_users_updated_at
    BEFORE UPDATE ON users
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_subjects_updated_at
    BEFORE UPDATE ON subjects
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_reviewers_updated_at
    BEFORE UPDATE ON reviewers
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

-- Function to clean old messages (keep last 1000 messages per chat type)
CREATE OR REPLACE FUNCTION cleanup_old_messages()
RETURNS void
LANGUAGE plpgsql
SET search_path = public, pg_catalog
AS $$
BEGIN
    DELETE FROM messages
    WHERE id IN (
        SELECT id FROM messages
        WHERE chat_type = 'general'
        ORDER BY created_at DESC
        OFFSET 1000
    );
    
    DELETE FROM messages
    WHERE id IN (
        SELECT id FROM messages
        WHERE chat_type = 'online'
        ORDER BY created_at DESC
        OFFSET 1000
    );
END;
$$;

-- Function to clean offline users (remove users inactive for 5 minutes)
CREATE OR REPLACE FUNCTION cleanup_offline_users()
RETURNS void
LANGUAGE plpgsql
SET search_path = public, pg_catalog
AS $$
BEGIN
    DELETE FROM online_users
    WHERE last_seen < NOW() - INTERVAL '5 minutes';
END;
$$;

-- =====================================================
-- VIEWS FOR ANALYTICS
-- =====================================================

-- View for admin analytics
CREATE OR REPLACE VIEW admin_analytics AS
SELECT
    (SELECT COUNT(*) FROM users) AS total_users,
    (SELECT COUNT(*) FROM users WHERE role = 'student') AS total_students,
    (SELECT COUNT(*) FROM users WHERE role = 'admin') AS total_admins,
    (SELECT COUNT(*) FROM subjects) AS total_subjects,
    (SELECT COUNT(*) FROM reviewers) AS total_reviewers,
    (SELECT COUNT(*) FROM messages WHERE chat_type = 'general') AS total_general_messages,
    (SELECT COUNT(*) FROM messages WHERE chat_type = 'online') AS total_online_messages,
    (SELECT COUNT(*) FROM online_users) AS current_online_users;

-- View for public reviewers with user info
CREATE OR REPLACE VIEW public_reviewers_view AS
SELECT
    r.id,
    r.title,
    r.content,
    r.created_at,
    r.updated_at,
    u.username,
    u.email,
    s.name AS subject_name,
    s.id AS subject_id
FROM reviewers r
JOIN users u ON r.user_id = u.id
JOIN subjects s ON r.subject_id = s.id
WHERE r.is_public = true
ORDER BY r.created_at DESC;

-- =====================================================
-- SAMPLE DATA (Optional - for testing)
-- =====================================================

-- Insert admin user (password: admin123)
-- Password hash for 'admin123' using bcrypt
INSERT INTO users (email, username, password_hash, role, is_verified)
VALUES (
    'admin@reviewer.com',
    'admin',
    '$2b$10$8KqxMZ0YkJ5lDZ0VQk5zQu7pTdKz5X.zJxKqVw5KqP5.zJxKqVw5K',
    'admin',
    true
) ON CONFLICT (email) DO NOTHING;

-- Insert sample student (password: student123)
INSERT INTO users (email, username, password_hash, role, is_verified)
VALUES (
    'student@reviewer.com',
    'student1',
    '$2b$10$8KqxMZ0YkJ5lDZ0VQk5zQu7pTdKz5X.zJxKqVw5KqP5.zJxKqVw5K',
    'student',
    true
) ON CONFLICT (email) DO NOTHING;

-- =====================================================
-- REALTIME PUBLICATION
-- =====================================================

-- Enable realtime for messages and online_users
ALTER PUBLICATION supabase_realtime ADD TABLE messages;
ALTER PUBLICATION supabase_realtime ADD TABLE online_users;

-- =====================================================
-- GRANT PERMISSIONS
-- =====================================================

-- Grant usage on schema
GRANT USAGE ON SCHEMA public TO postgres, anon, authenticated, service_role;

-- Grant all privileges to authenticated users
GRANT ALL ON ALL TABLES IN SCHEMA public TO postgres, authenticated, service_role;
GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO postgres, authenticated, service_role;
GRANT ALL ON ALL FUNCTIONS IN SCHEMA public TO postgres, authenticated, service_role;

-- Grant select on views
GRANT SELECT ON admin_analytics TO authenticated;
GRANT SELECT ON public_reviewers_view TO anon, authenticated;

-- =====================================================
-- COMMENTS
-- =====================================================

COMMENT ON TABLE users IS 'Stores user authentication and profile information';
COMMENT ON TABLE subjects IS 'Stores subjects created by students';
COMMENT ON TABLE reviewers IS 'Stores reviewer notes for each subject';
COMMENT ON TABLE messages IS 'Stores chat messages for general and online chat';
COMMENT ON TABLE online_users IS 'Tracks currently online users';
COMMENT ON VIEW admin_analytics IS 'Provides analytics summary for admin dashboard';
COMMENT ON VIEW public_reviewers_view IS 'Public view of all reviewers with user and subject information';
