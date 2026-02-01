-- Create policies table for managing community guidelines
-- Allows admin to CRUD policies that are displayed in policy.html
-- and used in moderation dropdowns

CREATE TABLE IF NOT EXISTS policies (
    id SERIAL PRIMARY KEY,
    title VARCHAR(255) NOT NULL,
    description TEXT NOT NULL,
    category VARCHAR(50) NOT NULL CHECK (category IN ('reviewer', 'message', 'both')),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Index for category filtering
CREATE INDEX IF NOT EXISTS idx_policies_category ON policies (category);

-- Add comments
COMMENT ON TABLE policies IS 'Community policy violations managed by administrators';
COMMENT ON COLUMN policies.category IS 'Policy applies to: reviewer content, messages, or both';

-- Insert default policies (matching current COMMUNITY_POLICIES constant)
INSERT INTO policies (title, description, category) VALUES
('Spam or Repetitive Content', 'Unsolicited messages, repetitive posts, or content designed to manipulate engagement metrics or flood discussions.', 'both'),
('Harassment or Bullying', 'Targeted attacks, insults, intimidation, or systematic campaigns to harm, embarrass, or silence another member.', 'both'),
('Hate Speech or Discrimination', 'Content promoting violence, hatred, or discrimination based on race, ethnicity, religion, gender, sexual orientation, disability, or other protected characteristics.', 'both'),
('Inappropriate or NSFW Content', 'Sexually explicit material, graphic violence, or other content not suitable for our educational community.', 'both'),
('Misinformation or False Information', 'Deliberately false or misleading claims presented as factual information, particularly in educational content.', 'reviewer'),
('Copyright Violation', 'Content that reproduces copyrighted works (text, images, videos) without proper permission or attribution.', 'reviewer'),
('Plagiarism', 'Copying substantial portions of another author''s work and presenting it as your own without proper citation.', 'reviewer'),
('Off-Topic or Irrelevant Content', 'Content that doesn''t belong in the given subject area, chat channel, or discussion context.', 'both'),
('Threatening or Violent Content', 'Content that threatens, encourages, or glorifies physical harm, violence, or dangerous activities.', 'both'),
('Sharing Personal Information', 'Posting someone''s private information (doxxing) such as addresses, phone numbers, or other sensitive data without consent.', 'both'),
('Impersonation', 'Pretending to be another person, organization, or entity to deceive or mislead others.', 'both'),
('Scam or Phishing Attempt', 'Content intended to defraud members, solicit sensitive information, or promote fraudulent schemes.', 'both'),
('Low Quality or Unhelpful Content', 'Reviewer posts that provide minimal educational value, lack substance, or contain numerous errors.', 'reviewer'),
('Excessive Profanity', 'Repeated use of strong profanity directed at other members or used in a harassing manner.', 'message'),
('Other Policy Violation', 'Content that violates our community guidelines but doesn''t fit into the above categories.', 'both');
