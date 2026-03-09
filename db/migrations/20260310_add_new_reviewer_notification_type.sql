-- Add 'new_reviewer' to the notifications type CHECK constraint.
-- Drops the existing constraint (whatever its name) and re-adds it with the full list.

DO $$
DECLARE
    v_constraint_name TEXT;
BEGIN
    SELECT conname INTO v_constraint_name
    FROM pg_constraint
    WHERE conrelid = 'notifications'::regclass
      AND contype = 'c'
      AND pg_get_constraintdef(oid) LIKE '%type%';

    IF v_constraint_name IS NOT NULL THEN
        EXECUTE format('ALTER TABLE notifications DROP CONSTRAINT %I', v_constraint_name);
    END IF;
END $$;

ALTER TABLE notifications
    ADD CONSTRAINT notifications_type_check
    CHECK (type IN ('reaction', 'comment', 'message', 'reply', 'follow', 'new_reviewer'));
