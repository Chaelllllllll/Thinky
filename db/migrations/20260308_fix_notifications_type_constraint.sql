-- Fix notifications type CHECK constraint to include 'follow'
-- The original constraint was created before 'follow' was a valid type,
-- so this migration drops and re-adds it with all current valid types.

DO $$
DECLARE
    v_constraint_name TEXT;
BEGIN
    -- Find and drop the existing type CHECK constraint on notifications
    SELECT conname INTO v_constraint_name
    FROM pg_constraint
    WHERE conrelid = 'notifications'::regclass
      AND contype = 'c'
      AND pg_get_constraintdef(oid) LIKE '%type%';

    IF v_constraint_name IS NOT NULL THEN
        EXECUTE format('ALTER TABLE notifications DROP CONSTRAINT %I', v_constraint_name);
    END IF;
END $$;

-- Add the updated constraint that includes all valid notification types
ALTER TABLE notifications
    ADD CONSTRAINT notifications_type_check
    CHECK (type IN ('reaction', 'comment', 'message', 'reply', 'follow'));
