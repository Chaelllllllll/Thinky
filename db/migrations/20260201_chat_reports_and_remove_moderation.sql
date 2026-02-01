-- Create chat_reports table and remove per-user message moderation columns
BEGIN;

-- Create reports table for chat messages
CREATE TABLE IF NOT EXISTS chat_reports (
  id bigserial PRIMARY KEY,
  reporter_id uuid REFERENCES users(id) ON DELETE SET NULL,
  message_id uuid REFERENCES messages(id) ON DELETE CASCADE,
  report_type varchar(100) DEFAULT 'inappropriate',
  details text DEFAULT NULL,
  status varchar(32) DEFAULT 'open',
  handled_by uuid DEFAULT NULL,
  handled_at timestamptz DEFAULT NULL,
  created_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_chat_reports_message_id ON chat_reports (message_id);
CREATE INDEX IF NOT EXISTS idx_chat_reports_status ON chat_reports (status);

-- Remove previous message moderation columns from users
ALTER TABLE users
  DROP COLUMN IF EXISTS message_warning_count,
  DROP COLUMN IF EXISTS message_warning_first_at,
  DROP COLUMN IF EXISTS message_muted_until;

COMMIT;
