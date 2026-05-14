-- Retention: track when a subject has zero reviewers, for automatic deletion after 10 days.
-- Also used by the app job that deletes unverified users (see server.js); that uses users.created_at only.
--
-- Apply in Supabase SQL editor after prior migrations.

-- 1) Column: when the subject last had zero reviewers (NULL = has at least one reviewer, or legacy unknown)
ALTER TABLE public.subjects
    ADD COLUMN IF NOT EXISTS empty_since TIMESTAMPTZ;

-- New subjects start "empty" from creation time until a reviewer is added
ALTER TABLE public.subjects
    ALTER COLUMN empty_since SET DEFAULT NOW();

-- 2) Normalize existing rows
UPDATE public.subjects s
SET empty_since = NULL
WHERE EXISTS (SELECT 1 FROM public.reviewers r WHERE r.subject_id = s.id);

-- Empty subjects without a clock yet: start grace period from migration time (avoids deleting long-idle shells immediately)
UPDATE public.subjects s
SET empty_since = NOW()
WHERE NOT EXISTS (SELECT 1 FROM public.reviewers r WHERE r.subject_id = s.id)
  AND s.empty_since IS NULL;

-- 3) Keep empty_since in sync when reviewers are added or removed
CREATE OR REPLACE FUNCTION public.subjects_sync_empty_since_from_reviewers()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        UPDATE public.subjects
        SET empty_since = NULL
        WHERE id = NEW.subject_id;
        RETURN NEW;
    ELSIF TG_OP = 'DELETE' THEN
        IF NOT EXISTS (SELECT 1 FROM public.reviewers r WHERE r.subject_id = OLD.subject_id) THEN
            UPDATE public.subjects
            SET empty_since = NOW()
            WHERE id = OLD.subject_id;
        END IF;
        RETURN OLD;
    END IF;
    RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS tr_reviewers_sync_empty_since_ins ON public.reviewers;
CREATE TRIGGER tr_reviewers_sync_empty_since_ins
    AFTER INSERT ON public.reviewers
    FOR EACH ROW
    EXECUTE PROCEDURE public.subjects_sync_empty_since_from_reviewers();

DROP TRIGGER IF EXISTS tr_reviewers_sync_empty_since_del ON public.reviewers;
CREATE TRIGGER tr_reviewers_sync_empty_since_del
    AFTER DELETE ON public.reviewers
    FOR EACH ROW
    EXECUTE PROCEDURE public.subjects_sync_empty_since_from_reviewers();

COMMENT ON COLUMN public.subjects.empty_since IS 'UTC time when the subject last had zero reviewers; NULL if it currently has at least one.';
