-- Add role column to users table (if not exists)
BEGIN;

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS role varchar(32) DEFAULT 'student';

COMMIT;
