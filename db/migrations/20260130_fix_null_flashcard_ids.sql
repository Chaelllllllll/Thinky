-- Migration: populate missing flashcard ids in reviewers.flashcards
-- Date: 2026-01-30

-- Ensure uuid extension available
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- For each reviewer, replace any flashcard elements missing an id or with null id
-- by adding a newly generated UUID to that element.
UPDATE reviewers
SET flashcards = (
  SELECT jsonb_agg(
    CASE
      WHEN (elem->>'id') IS NULL OR (elem->>'id') = '' OR (elem->>'id') = 'null' THEN (elem || jsonb_build_object('id', uuid_generate_v4()))
      ELSE elem
    END
  )
  FROM jsonb_array_elements(flashcards) AS elem
)
WHERE flashcards IS NOT NULL AND jsonb_typeof(flashcards) = 'array';

-- Optional: inspect rows to confirm
-- SELECT id, flashcards FROM reviewers WHERE flashcards IS NOT NULL LIMIT 20;
