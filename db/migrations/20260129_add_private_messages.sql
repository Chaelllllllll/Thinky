-- Migration: Add private messaging support
-- Adds recipient_id to messages, index, allows chat_type='private', and updates RLS policies

BEGIN;

-- Add recipient_id if missing
ALTER TABLE public.messages
    ADD COLUMN IF NOT EXISTS recipient_id UUID REFERENCES public.users(id) ON DELETE CASCADE;

-- Update chat_type check constraint to include 'private'
ALTER TABLE public.messages
    DROP CONSTRAINT IF EXISTS messages_chat_type_check;

ALTER TABLE public.messages
    ADD CONSTRAINT messages_chat_type_check CHECK (chat_type IN ('general','online','private'));

-- Add index on recipient_id
CREATE INDEX IF NOT EXISTS idx_messages_recipient_id ON public.messages(recipient_id);

-- Ensure RLS is enabled
ALTER TABLE public.messages ENABLE ROW LEVEL SECURITY;

-- Replace existing message policies with conservative rules for private messages
DROP POLICY IF EXISTS "Users can view messages when allowed" ON public.messages;
DROP POLICY IF EXISTS "Anyone can view messages" ON public.messages;
DROP POLICY IF EXISTS "Authenticated users can insert messages" ON public.messages;
DROP POLICY IF EXISTS "Users can delete own messages" ON public.messages;

CREATE POLICY "Users can view messages when allowed" ON public.messages
    FOR SELECT
    USING (
        chat_type != 'private' OR auth.uid() = user_id OR auth.uid() = recipient_id
    );

CREATE POLICY "Authenticated users can insert messages" ON public.messages
    FOR INSERT
    WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can delete own messages" ON public.messages
    FOR DELETE USING (auth.uid() = user_id);

COMMIT;

--
-- DOWN migration (revert):
-- BEGIN;
-- ALTER TABLE public.messages DROP CONSTRAINT IF EXISTS messages_chat_type_check;
-- ALTER TABLE public.messages ADD CONSTRAINT messages_chat_type_check CHECK (chat_type IN ('general','online'));
-- DROP INDEX IF EXISTS idx_messages_recipient_id;
-- ALTER TABLE public.messages DROP COLUMN IF EXISTS recipient_id;
-- DROP POLICY IF EXISTS "Users can view messages when allowed" ON public.messages;
-- DROP POLICY IF EXISTS "Authenticated users can insert messages" ON public.messages;
-- DROP POLICY IF EXISTS "Users can delete own messages" ON public.messages;
-- CREATE POLICY "Anyone can view messages" ON public.messages FOR SELECT USING (true);
-- CREATE POLICY "Authenticated users can insert messages" ON public.messages FOR INSERT WITH CHECK (auth.uid() = user_id);
-- CREATE POLICY "Users can delete own messages" ON public.messages FOR DELETE USING (auth.uid() = user_id);
-- COMMIT;
