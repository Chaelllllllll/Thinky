-- Add quiz JSONB column to store quiz data per reviewer
-- Quiz structure: { timer: null | number(seconds), questions: [{id, question, options[], correct}] }
ALTER TABLE reviewers ADD COLUMN IF NOT EXISTS quiz JSONB;
