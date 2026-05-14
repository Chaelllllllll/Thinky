/**
 * Tracks qualified reads on reviewer.html: dwell time, scroll depth, MBID surfaces.
 * Credits the reviewer author via POST /api/reviewers/:id/monetization/engage (server-side rules).
 */
(function () {
    'use strict';

    const STORAGE_KEY = 'thinky_mon_vid';
    let reviewerId = null;
    let sent = false;
    let startMs = Date.now();
    let maxScrollPct = 0;
    let mbidSurfaces = 0;
    let mbidObservers = [];

    function getReviewerIdFromQuery() {
        try {
            const q = new URLSearchParams(window.location.search);
            return q.get('id');
        } catch (_) {
            return null;
        }
    }

    function getOrCreateVisitorId() {
        try {
            let v = localStorage.getItem(STORAGE_KEY);
            if (!v || v.length < 8) {
                v =
                    (typeof crypto !== 'undefined' && crypto.randomUUID && crypto.randomUUID()) ||
                    String(Math.random()).slice(2) + String(Date.now());
                localStorage.setItem(STORAGE_KEY, v);
            }
            return v;
        } catch (_) {
            return 'sess-' + String(Date.now());
        }
    }

    function measureScrollPct() {
        const el = document.documentElement;
        const sh = el.scrollHeight - window.innerHeight;
        if (sh <= 0) return 100;
        return Math.min(100, Math.round((window.scrollY / sh) * 100));
    }

    function countMbidSurfaces() {
        let n = 0;
        document.querySelectorAll('.thinky-mbid-slot [data-banner-id], .thinky-mbid-collapse-root [data-banner-id]').forEach((root) => {
            if (root.closest('#adModal')) return;
            if (root.querySelector('iframe[src], iframe[srcdoc]')) n += 1;
        });
        return n;
    }

    function wireMbidObservers() {
        mbidObservers.forEach((o) => {
            try {
                o.disconnect();
            } catch (_) {}
        });
        mbidObservers = [];
        document.querySelectorAll('.thinky-mbid-slot [data-banner-id], .thinky-mbid-collapse-root [data-banner-id]').forEach((inner) => {
            if (inner.closest('#adModal')) return;
            const obs = new MutationObserver(() => {
                mbidSurfaces = Math.max(mbidSurfaces, countMbidSurfaces());
            });
            obs.observe(inner, { childList: true, subtree: true });
            mbidObservers.push(obs);
        });
    }

    async function sendEngage() {
        if (sent || !reviewerId) return;
        sent = true;
        const dwellMs = Math.max(0, Date.now() - startMs);
        const scrollPct = Math.max(maxScrollPct, measureScrollPct());
        mbidSurfaces = Math.max(mbidSurfaces, countMbidSurfaces());

        try {
            const resp = await fetch(`/api/reviewers/${encodeURIComponent(reviewerId)}/monetization/engage`, {
                method: 'POST',
                credentials: 'include',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    dwellMs,
                    scrollPct,
                    mbidSurfaces,
                    clientVisitorId: getOrCreateVisitorId()
                })
            });
            const data = await resp.json().catch(() => ({}));
            if (resp.ok && data.credited) {
                window.dispatchEvent(
                    new CustomEvent('thinkyMonetizationCredited', {
                        detail: { reviewerId, amount_micro: data.amount_micro }
                    })
                );
            }
        } catch (e) {
            console.warn('Monetization engage failed', e);
        }
    }

    function onScroll() {
        maxScrollPct = Math.max(maxScrollPct, measureScrollPct());
    }

    function init() {
        reviewerId = getReviewerIdFromQuery();
        if (!reviewerId) return;

        startMs = Date.now();
        window.addEventListener('scroll', onScroll, { passive: true });

        if (typeof window.wireThinkyMbidCollapseIfNeeded === 'function') {
            document.querySelectorAll('.thinky-mbid-collapse-root').forEach((el) => {
                if (el.closest('#adModal')) return;
                delete el.dataset.mbidCollapseArmed;
                window.wireThinkyMbidCollapseIfNeeded(el);
            });
        }
        if (typeof window.nudgeThinkyMbid === 'function') {
            window.nudgeThinkyMbid();
        }

        wireMbidObservers();

        const recheckMbid = () => {
            mbidSurfaces = Math.max(mbidSurfaces, countMbidSurfaces());
        };
        [2000, 5000, 12000].forEach((t) => setTimeout(recheckMbid, t));

        let cfg = { minDwellMs: 12000, minScrollPct: 38 };
        fetch('/api/me/monetization', { credentials: 'include' })
            .then((r) => (r.ok ? r.json() : null))
            .then((body) => {
                if (body && body.config) {
                    cfg.minDwellMs = body.config.minDwellMs || cfg.minDwellMs;
                    cfg.minScrollPct = body.config.minScrollPct || cfg.minScrollPct;
                }
            })
            .catch(() => {});

        let tick = setInterval(() => {
            if (sent) {
                clearInterval(tick);
                return;
            }
            const dwell = Date.now() - startMs;
            maxScrollPct = Math.max(maxScrollPct, measureScrollPct());
            recheckMbid();
            if (dwell >= cfg.minDwellMs && maxScrollPct >= cfg.minScrollPct) {
                clearInterval(tick);
                sendEngage();
            }
        }, 2000);

        setTimeout(() => {
            clearInterval(tick);
        }, 30 * 60 * 1000);

        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'hidden') {
                maxScrollPct = Math.max(maxScrollPct, measureScrollPct());
                mbidSurfaces = Math.max(mbidSurfaces, countMbidSurfaces());
            }
        });

        window.addEventListener('beforeunload', () => {
            maxScrollPct = Math.max(maxScrollPct, measureScrollPct());
        });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
