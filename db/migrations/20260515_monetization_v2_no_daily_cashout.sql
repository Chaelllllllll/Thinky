-- v2: Remove "one read per day" cap. Each qualifying credit is recorded (anti-spam: client sends once per page load; API rate-limited).
-- Adds PHP cashout requests (min ₱500) and RPC to deduct balance atomically.
-- Apply AFTER 20260514 if you already ran it.

-- Drop old daily-claim flow
DROP TABLE IF EXISTS public.reviewer_monetization_daily_claims CASCADE;

DROP FUNCTION IF EXISTS public.credit_reviewer_read_reward(UUID, UUID, TEXT, DATE, UUID, BIGINT, JSONB);

CREATE OR REPLACE FUNCTION public.credit_reviewer_read_reward(
    p_reviewer_id UUID,
    p_owner_id UUID,
    p_viewer_id UUID,
    p_amount_micro BIGINT,
    p_meta JSONB DEFAULT '{}'::jsonb
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    IF COALESCE(p_amount_micro, 0) <= 0 THEN
        RETURN jsonb_build_object('credited', false, 'reason', 'invalid_amount');
    END IF;

    IF p_viewer_id IS NOT NULL AND p_viewer_id = p_owner_id THEN
        RETURN jsonb_build_object('credited', false, 'reason', 'owner_view');
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

    RETURN jsonb_build_object('credited', true, 'amount_micro', p_amount_micro);
END;
$$;

REVOKE ALL ON FUNCTION public.credit_reviewer_read_reward(UUID, UUID, UUID, BIGINT, JSONB) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.credit_reviewer_read_reward(UUID, UUID, UUID, BIGINT, JSONB) TO service_role;

COMMENT ON FUNCTION public.credit_reviewer_read_reward IS 'Credits author for one qualified read (no per-day cap).';

-- Cashout: deduct available balance when user requests payout (PHP min enforced in RPC)
CREATE TABLE IF NOT EXISTS public.monetization_cashout_requests (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    amount_php NUMERIC(14, 2) NOT NULL,
    amount_micro BIGINT NOT NULL,
    usd_to_php_rate NUMERIC(14, 6) NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'paid')),
    admin_note TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_monetization_cashout_user_created
    ON public.monetization_cashout_requests (user_id, created_at DESC);

CREATE OR REPLACE FUNCTION public.request_monetization_cashout(
    p_user_id UUID,
    p_amount_php NUMERIC,
    p_usd_to_php NUMERIC
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_micro BIGINT;
    v_bal BIGINT;
    min_php CONSTANT NUMERIC := 500;
BEGIN
    IF p_amount_php IS NULL OR p_amount_php < min_php THEN
        RETURN jsonb_build_object('ok', false, 'reason', 'below_min', 'min_php', min_php);
    END IF;
    IF p_usd_to_php IS NULL OR p_usd_to_php <= 0 THEN
        RETURN jsonb_build_object('ok', false, 'reason', 'bad_rate');
    END IF;

    v_micro := FLOOR((p_amount_php / p_usd_to_php) * 1000000)::BIGINT;
    IF v_micro <= 0 THEN
        RETURN jsonb_build_object('ok', false, 'reason', 'amount_too_small');
    END IF;

    INSERT INTO public.user_monetization_balance (user_id, balance_micro, lifetime_credited_micro, updated_at)
    VALUES (p_user_id, 0, 0, NOW())
    ON CONFLICT (user_id) DO NOTHING;

    SELECT balance_micro INTO v_bal
    FROM public.user_monetization_balance
    WHERE user_id = p_user_id
    FOR UPDATE;

    IF v_bal IS NULL OR v_bal < v_micro THEN
        RETURN jsonb_build_object('ok', false, 'reason', 'insufficient_balance', 'balance_micro', COALESCE(v_bal, 0), 'required_micro', v_micro);
    END IF;

    INSERT INTO public.monetization_cashout_requests (user_id, amount_php, amount_micro, usd_to_php_rate, status)
    VALUES (p_user_id, p_amount_php, v_micro, p_usd_to_php, 'pending');

    UPDATE public.user_monetization_balance
    SET balance_micro = balance_micro - v_micro,
        updated_at = NOW()
    WHERE user_id = p_user_id;

    RETURN jsonb_build_object('ok', true, 'amount_php', p_amount_php, 'amount_micro', v_micro);
END;
$$;

REVOKE ALL ON FUNCTION public.request_monetization_cashout(UUID, NUMERIC, NUMERIC) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.request_monetization_cashout(UUID, NUMERIC, NUMERIC) TO service_role;
