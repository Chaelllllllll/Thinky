-- Migration: add compiler_language column to reviewers
-- Stores the programming language for the optional in-reviewer compiler.
-- NULL or empty = no compiler. e.g. 'python', 'cpp', 'javascript', etc.
-- Date: 2026-03-09

ALTER TABLE reviewers
    ADD COLUMN IF NOT EXISTS compiler_language TEXT;
