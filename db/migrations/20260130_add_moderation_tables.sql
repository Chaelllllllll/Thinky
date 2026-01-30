-- Add moderation tables and user ban/restriction columns

ALTER TABLE users
    ADD COLUMN IF NOT EXISTS banned_until TIMESTAMP WITH TIME ZONE,
    ADD COLUMN IF NOT EXISTS blocked_from_creating_until TIMESTAMP WITH TIME ZONE;

CREATE TABLE IF NOT EXISTS reviewer_reports (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    reviewer_id UUID NOT NULL REFERENCES reviewers(id) ON DELETE CASCADE,
    reporter_id UUID NOT NULL REFERENCES users(id) ON DELETE SET NULL,
    report_type VARCHAR(100) NOT NULL,
    details TEXT,
    status VARCHAR(32) DEFAULT 'open' CHECK (status IN ('open','resolved','dismissed')),
    action_taken_by UUID REFERENCES users(id) ON DELETE SET NULL,
    action_taken TEXT,
    action_taken_at TIMESTAMP WITH TIME ZONE,
    resolved_at TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX idx_report_reviewer_id ON reviewer_reports(reviewer_id);
CREATE INDEX idx_report_reporter_id ON reviewer_reports(reporter_id);
CREATE INDEX idx_report_status ON reviewer_reports(status);
