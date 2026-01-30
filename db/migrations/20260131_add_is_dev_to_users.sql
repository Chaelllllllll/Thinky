-- Add is_dev column to users
ALTER TABLE users
ADD COLUMN IF NOT EXISTS is_dev boolean NOT NULL DEFAULT false;
