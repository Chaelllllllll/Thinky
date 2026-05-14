-- Reviewer monetization: author earnings from qualified reads (Thinky platform credits, micro-USD).
-- Run in Supabase SQL editor or your migration pipeline. Service role / server calls RPC only.

CREATE TABLE IF NOT EXISTS public.reviewer_monetization_daily_claims (
    reviewer_id UUID NOT NULL REFERENCES public.reviewers(id) ON DELETE CASCADE,
    visitor_key TEXT NOT NULL,
    claim_date DATE NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (reviewer_id, visitor_key, claim_date)
);

CREATE INDEX IF NOT EXISTS idx_monetization_claims_owner_day
    ON public.reviewer_monetization_daily_claims (reviewer_id, claim_date DESC);

CREATE TABLE IF NOT EXISTS public.reviewer_earnings_ledger (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    beneficiary_user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    reviewer_id UUID REFERENCES public.reviewers(id) ON DELETE SET NULL,
    viewer_user_id UUID REFERENCES public.users(id) ON DELETE SET NULL,
    event_type TEXT NOT NULL,
    amount_micro BIGINT NOT NULL,
    meta JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_reviewer_earnings_ledger_beneficiary_created
    ON public.reviewer_earnings_ledger (beneficiary_user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS public.user_monetization_balance (
    user_id UUID PRIMARY KEY REFERENCES public.users(id) ON DELETE CASCADE,
    balance_micro BIGINT NOT NULL DEFAULT 0,
    lifetime_credited_micro BIGINT NOT NULL DEFAULT 0,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE OR REPLACE FUNCTION public.credit_reviewer_read_reward(
    p_reviewer_id UUID,
    p_owner_id UUID,
    p_visitor_key TEXT,
    p_claim_date DATE,
    p_viewer_id UUID,
    p_amount_micro BIGINT,
    p_meta JSONB DEFAULT '{}'::jsonb
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_inserted INT := 0;
BEGIN
    IF COALESCE(p_amount_micro, 0) <= 0 THEN
        RETURN jsonb_build_object('credited', false, 'reason', 'invalid_amount');
    END IF;

    IF p_viewer_id IS NOT NULL AND p_viewer_id = p_owner_id THEN
        RETURN jsonb_build_object('credited', false, 'reason', 'owner_view');
    END IF;

    INSERT INTO public.reviewer_monetization_daily_claims (reviewer_id, visitor_key, claim_date)
    VALUES (p_reviewer_id, p_visitor_key, p_claim_date)
    ON CONFLICT DO NOTHING;

    GET DIAGNOSTICS v_inserted = ROW_COUNT;

    IF v_inserted = 0 THEN
        RETURN jsonb_build_object('credited', false, 'reason', 'daily_cap');
    END IF;

    INSERT INTO public.reviewer_earnings_ledger (
        beneficiary_user_id, reviewer_id, viewer_user_id, event_type, amount_micro, meta
    ) VALUES (
        p_owner_id, p_reviewer_id, p_viewer_id, 'qualified_read', p_amount_micro, COALESCE(p_meta, '{}'::jsonb)
    );

    INSERT INTO public.user_monetization_balance (user_id, balance_micro, lifetime_credited_micro, updated_at)
    VALUES (p_owner_id, p_amount_micro, p_amount_micro, NOW())
    ON CONFLICT (user_id) DO UPDATE SET
        balance_micro = public.user_monetization_balance.balance_micro + EXCLUDED.balance_micro,
        lifetime_credited_micro = public.user_monetization_balance.lifetime_credited_micro + EXCLUDED.lifetime_credited_micro,
        updated_at = NOW();

    RETURN jsonb_build_object(
        'credited', true,
        'amount_micro', p_amount_micro
    );
END;
$$;

REVOKE ALL ON FUNCTION public.credit_reviewer_read_reward(UUID, UUID, TEXT, DATE, UUID, BIGINT, JSONB) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.credit_reviewer_read_reward(UUID, UUID, TEXT, DATE, UUID, BIGINT, JSONB) TO service_role;

COMMENT ON TABLE public.reviewer_earnings_ledger IS 'Immutable credits to authors; amounts in micro-dollars (1e-6 USD).';
COMMENT ON FUNCTION public.credit_reviewer_read_reward IS 'Idempotent daily credit for one visitor key per reviewer per UTC day.';
