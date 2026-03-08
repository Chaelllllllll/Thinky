-- Add is_pinned column to reviewer_comments
ALTER TABLE reviewer_comments ADD COLUMN IF NOT EXISTS is_pinned BOOLEAN NOT NULL DEFAULT FALSE;

-- Partial index: only one pinned per reviewer (enforced client-side, index for query perf)
CREATE INDEX IF NOT EXISTS idx_reviewer_comments_pinned ON reviewer_comments(reviewer_id) WHERE is_pinned = TRUE;
