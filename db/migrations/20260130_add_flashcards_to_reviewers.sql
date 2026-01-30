-- Migration: add flashcards JSONB column to reviewers
-- Date: 2026-01-30

ALTER TABLE reviewers
    ADD COLUMN IF NOT EXISTS flashcards JSONB;

-- Optional: create a GIN index to speed JSONB queries
CREATE INDEX IF NOT EXISTS idx_reviewers_flashcards_gin ON reviewers USING gin (flashcards);
