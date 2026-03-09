-- Add 'school_request' to notifications type constraint
DO $$
DECLARE
    v_name TEXT;
BEGIN
    SELECT constraint_name INTO v_name
    FROM information_schema.table_constraints
    WHERE table_name = 'notifications'
      AND constraint_type = 'CHECK'
      AND constraint_name ILIKE '%type%';

    IF v_name IS NOT NULL THEN
        EXECUTE format('ALTER TABLE notifications DROP CONSTRAINT %I', v_name);
    END IF;

    ALTER TABLE notifications
        ADD CONSTRAINT notifications_type_check
        CHECK (type IN ('reaction', 'comment', 'message', 'reply', 'follow', 'new_reviewer', 'school_request'));
END $$;
