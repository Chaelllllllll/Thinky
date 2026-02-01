-- Migration: Fix RLS auth() performance and role-mutable search_path for functions
-- This script:
-- 1) Recreates server-side functions with explicit search_path
-- 2) Recreates/updates RLS policies to call auth functions via (select auth.uid())
-- 3) Attempts to ALTER existing handle_new_user function(s) to set search_path
-- 4) Drops duplicate session index if present

BEGIN;

-- =====================================================
-- 1) Recreate functions with explicit search_path
-- =====================================================

CREATE OR REPLACE FUNCTION public.update_updated_at_column()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public, pg_catalog
AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.cleanup_old_messages()
RETURNS void
LANGUAGE plpgsql
SET search_path = public, pg_catalog
AS $$
BEGIN
    DELETE FROM messages
    WHERE id IN (
        SELECT id FROM messages
        WHERE chat_type = 'general'
        ORDER BY created_at DESC
        OFFSET 1000
    );

    DELETE FROM messages
    WHERE id IN (
        SELECT id FROM messages
        WHERE chat_type = 'online'
        ORDER BY created_at DESC
        OFFSET 1000
    );
END;
$$;

CREATE OR REPLACE FUNCTION public.cleanup_offline_users()
RETURNS void
LANGUAGE plpgsql
SET search_path = public, pg_catalog
AS $$
BEGIN
    DELETE FROM online_users
    WHERE last_seen < NOW() - INTERVAL '5 minutes';
END;
$$;

-- =====================================================
-- 2) Update RLS policies to call auth functions via SELECT
-- =====================================================

-- Users table
DROP POLICY IF EXISTS "Users can update own profile" ON public.users;
CREATE POLICY "Users can update own profile" ON public.users
    FOR UPDATE USING ((select auth.uid()) = id);

-- Subjects table
DROP POLICY IF EXISTS "Users can insert own subjects" ON public.subjects;
CREATE POLICY "Users can insert own subjects" ON public.subjects
    FOR INSERT WITH CHECK ((select auth.uid()) = user_id);

DROP POLICY IF EXISTS "Users can update own subjects" ON public.subjects;
CREATE POLICY "Users can update own subjects" ON public.subjects
    FOR UPDATE USING ((select auth.uid()) = user_id);

DROP POLICY IF EXISTS "Users can delete own subjects" ON public.subjects;
CREATE POLICY "Users can delete own subjects" ON public.subjects
    FOR DELETE USING ((select auth.uid()) = user_id);

-- Reviewers table
DROP POLICY IF EXISTS "Users can view own reviewers" ON public.reviewers;
CREATE POLICY "Users can view own reviewers" ON public.reviewers
    FOR SELECT USING ((select auth.uid()) = user_id);

DROP POLICY IF EXISTS "Users can insert own reviewers" ON public.reviewers;
CREATE POLICY "Users can insert own reviewers" ON public.reviewers
    FOR INSERT WITH CHECK ((select auth.uid()) = user_id);

DROP POLICY IF EXISTS "Users can update own reviewers" ON public.reviewers;
CREATE POLICY "Users can update own reviewers" ON public.reviewers
    FOR UPDATE USING ((select auth.uid()) = user_id);

DROP POLICY IF EXISTS "Users can delete own reviewers" ON public.reviewers;
CREATE POLICY "Users can delete own reviewers" ON public.reviewers
    FOR DELETE USING ((select auth.uid()) = user_id);

-- Messages table
DROP POLICY IF EXISTS "Users can view messages when allowed" ON public.messages;
CREATE POLICY "Users can view messages when allowed" ON public.messages
    FOR SELECT
    USING (
        chat_type != 'private' OR (select auth.uid()) = user_id OR (select auth.uid()) = recipient_id
    );

DROP POLICY IF EXISTS "Authenticated users can insert messages" ON public.messages;
CREATE POLICY "Authenticated users can insert messages" ON public.messages
    FOR INSERT
    WITH CHECK ((select auth.uid()) = user_id);

DROP POLICY IF EXISTS "Users can delete own messages" ON public.messages;
CREATE POLICY "Users can delete own messages" ON public.messages
    FOR DELETE USING ((select auth.uid()) = user_id);

-- Online users
DROP POLICY IF EXISTS "Users can insert own online status" ON public.online_users;
CREATE POLICY "Users can insert own online status" ON public.online_users
    FOR INSERT WITH CHECK ((select auth.uid()) = user_id);

DROP POLICY IF EXISTS "Users can update own online status" ON public.online_users;
CREATE POLICY "Users can update own online status" ON public.online_users
    FOR UPDATE USING ((select auth.uid()) = user_id);

DROP POLICY IF EXISTS "Users can delete own online status" ON public.online_users;
CREATE POLICY "Users can delete own online status" ON public.online_users
    FOR DELETE USING ((select auth.uid()) = user_id);

-- =====================================================
-- 3) Attempt to set search_path for existing handle_new_user functions (all overloads)
-- This dynamic block will ALTER existing functions named handle_new_user in public schema
-- to set their search_path. It will do nothing if no such function exists.
-- =====================================================

DO $$
DECLARE r RECORD;
BEGIN
  FOR r IN
    SELECT p.oid, n.nspname, p.proname, pg_get_function_identity_arguments(p.oid) AS args
    FROM pg_proc p
    JOIN pg_namespace n ON p.pronamespace = n.oid
    WHERE n.nspname = 'public' AND p.proname = 'handle_new_user'
  LOOP
    EXECUTE format('ALTER FUNCTION public.%I(%s) SET search_path = public, pg_catalog;', r.proname, r.args);
  END LOOP;
END
$$;

-- =====================================================
-- 4) Drop duplicate session index if present
-- =====================================================
DROP INDEX IF EXISTS session_id_key;

COMMIT;
