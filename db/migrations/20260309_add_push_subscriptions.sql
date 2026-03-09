-- Push notification subscriptions for PWA
CREATE TABLE IF NOT EXISTS push_subscriptions (
    id           UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id      UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    endpoint     TEXT        NOT NULL,
    p256dh       TEXT        NOT NULL,
    auth         TEXT        NOT NULL,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (user_id, endpoint)
);

CREATE INDEX IF NOT EXISTS idx_push_subscriptions_user_id ON push_subscriptions(user_id);
