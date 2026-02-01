-- =====================================================
-- Add User Settings Columns
-- Notifications preferences and Two-Factor Authentication
-- =====================================================

-- Add notification preferences
ALTER TABLE users
    ADD COLUMN IF NOT EXISTS notif_general_chat BOOLEAN DEFAULT TRUE,
    ADD COLUMN IF NOT EXISTS notif_private_messages BOOLEAN DEFAULT TRUE;

-- Add 2FA columns
ALTER TABLE users
    ADD COLUMN IF NOT EXISTS two_factor_enabled BOOLEAN DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS two_factor_secret TEXT, -- TOTP secret for Google Authenticator
    ADD COLUMN IF NOT EXISTS email_2fa_enabled BOOLEAN DEFAULT FALSE;

-- Create table for email 2FA codes
CREATE TABLE IF NOT EXISTS email_2fa_codes (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    code VARCHAR(6) NOT NULL,
    expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
    used BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Create index for faster lookups
CREATE INDEX idx_email_2fa_codes_user_id ON email_2fa_codes(user_id);
CREATE INDEX idx_email_2fa_codes_expires_at ON email_2fa_codes(expires_at);

-- Add comment
COMMENT ON TABLE email_2fa_codes IS 'Stores temporary 6-digit codes for email-based two-factor authentication';
