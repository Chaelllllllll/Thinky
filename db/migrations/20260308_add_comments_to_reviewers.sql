-- Comments on reviewers (top-level comments and nested replies)
CREATE TABLE IF NOT EXISTS reviewer_comments (
    id         UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    reviewer_id UUID NOT NULL REFERENCES reviewers(id) ON DELETE CASCADE,
    user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    parent_id  UUID REFERENCES reviewer_comments(id) ON DELETE CASCADE,
    content    TEXT NOT NULL CHECK (char_length(content) BETWEEN 1 AND 2000),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_reviewer_comments_reviewer ON reviewer_comments(reviewer_id);
CREATE INDEX IF NOT EXISTS idx_reviewer_comments_parent  ON reviewer_comments(parent_id);

-- One reaction type per user per comment (toggle model)
CREATE TABLE IF NOT EXISTS reviewer_comment_reactions (
    id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    comment_id    UUID NOT NULL REFERENCES reviewer_comments(id) ON DELETE CASCADE,
    user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    reaction_type VARCHAR(10) NOT NULL CHECK (reaction_type IN ('like','haha','sad','wow','heart')),
    created_at    TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    UNIQUE (comment_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_comment_reactions_comment ON reviewer_comment_reactions(comment_id);
