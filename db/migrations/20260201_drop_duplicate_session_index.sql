-- Drop duplicate index on session table if present
-- Keeps the primary key index (session_pkey) and removes any duplicate named session_id_key

BEGIN;

DROP INDEX IF EXISTS session_id_key;

COMMIT;
