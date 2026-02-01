-- Update users.role check constraint to include 'moderator'
BEGIN;

-- Drop existing check constraint if present (safe to run repeatedly)
ALTER TABLE users
  DROP CONSTRAINT IF EXISTS users_role_check;

-- Recreate the constraint allowing the expected roles
ALTER TABLE users
  ADD CONSTRAINT users_role_check CHECK (role IN ('student','moderator','admin'));

COMMIT;
