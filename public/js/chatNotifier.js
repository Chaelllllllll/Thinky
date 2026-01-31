// Lightweight notifier for pages without the full chat UI.
// Shows toasts for new messages using window.showChatNotification.
(async function(){
    if (typeof window.showChatNotification !== 'function') {
        return; // alerts system not available
    }

    let currentUser = null;
    async function loadCurrentUser() {
        try {
            const r = await fetch('/api/auth/me', { credentials: 'include' });
            if (!r.ok) return null;
            const d = await r.json();
            return d.user || null;
        } catch (e) { return null; }
    }

    currentUser = await loadCurrentUser();

    // Try realtime via Supabase
    async function tryRealtime() {
        const env = (window && window.ENV) ? window.ENV : window;
        const url = env.SUPABASE_URL || env.SUPABASE_URL || window.SUPABASE_URL || null;
        const key = env.SUPABASE_ANON_KEY || env.SUPABASE_KEY || window.SUPABASE_KEY || null;
        if (!url || !key) return false;

        if (!window.supabase || !window.supabase.createClient) {
            try {
                await new Promise((res, rej) => {
                    const s = document.createElement('script'); s.async = true; s.src = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js/dist/umd/supabase.min.js';
                    s.onload = res; s.onerror = rej; document.head.appendChild(s);
                });
            } catch (e) { return false; }
        }

        try {
            const client = window.supabase.createClient(url, key);
            const channel = client.channel('public:messages-notifier')
                .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'messages' }, async (payload) => {
                    console.debug('chatNotifier: realtime INSERT payload received', payload && payload.new ? { id: payload.new.id, user_id: payload.new.user_id, message: (payload.new.message || '').slice(0,60) } : payload);
                    try {
                        const n = payload && payload.new ? payload.new : null;
                        if (!n) return;
                        if (currentUser && String(n.user_id) === String(currentUser.id)) return; // skip our own

                        const avatar = (n.profile_picture_url) ? n.profile_picture_url : (n.avatar_url || '/images/default-avatar.svg');
                        const username = n.username || n.display_name || ('User ' + String(n.user_id));
                        const text = n.message || '';
                        const chatType = n.chat_type || (n.recipient_id ? 'private' : 'general');
                        console.debug('chatNotifier: emitting toast for realtime message', { username, chatType, textPreview: text.slice(0,60) });
                        window.showChatNotification({ avatar, username, message: text, chatType }, 6000);
                    } catch (e) { /* ignore */ }
                })
                .subscribe((status) => {
                    console.debug('chatNotifier: subscription status ->', status);
                });
            console.debug('chatNotifier: realtime subscription attempted');
            return true;
        } catch (e) {
            console.debug('chatNotifier: realtime init failed', e && e.message ? e.message : e);
            return false;
        }
    }

    // Polling fallback: check unread counts and fetch latest messages when changed
    let lastGeneral = new Date().toISOString();
    let lastPrivate = new Date().toISOString();

    async function poll() {
        try {
            // Prefer using shared unread poll so we don't duplicate requests
            let data = null;
            if (typeof window.pollSharedUnread === 'function') {
                data = await window.pollSharedUnread();
            } else {
                const lg = encodeURIComponent(lastGeneral);
                const lp = encodeURIComponent(lastPrivate);
                const unreadUrl = `/api/messages/unread?lastSeenGeneral=${lg}&lastSeenPrivate=${lp}`;
                console.debug('chatNotifier: polling unread URL', unreadUrl);
                const resp = await fetch(unreadUrl, { credentials: 'include' });
                if (!resp.ok) { console.debug('chatNotifier: unread fetch not ok', resp.status, resp.statusText); return; }
                data = await resp.json();
            }
            const g = data && data.general ? parseInt(data.general,10) : 0;
            const p = data && data.private ? parseInt(data.private,10) : 0;
            if (g > 0) {
                // fetch latest general messages and notify
                const r = await fetch('/api/messages/general?limit=3', { credentials: 'include' });
                if (r.ok) {
                    const d = await r.json();
                    const msgs = d && d.messages ? d.messages : [];
                    for (let i = msgs.length-1; i>=0; i--) {
                        const m = msgs[i];
                        if (currentUser && String(m.user_id) === String(currentUser.id)) continue;
                        console.debug('chatNotifier: polling -> notifying general message', { id: m.id, user_id: m.user_id, preview: (m.message || '').slice(0,60) });
                        window.showChatNotification({ avatar: (m.users && m.users.profile_picture_url) ? m.users.profile_picture_url : '/images/default-avatar.svg', username: m.username || 'User', message: m.message, chatType: 'general' }, 6000);
                    }
                    lastGeneral = new Date().toISOString();
                }
            }
            if (p > 0) {
                // For private, we simply fetch private messages
                const r = await fetch('/api/messages/private?limit=3', { credentials: 'include' });
                if (r.ok) {
                    const d = await r.json();
                    const msgs = d && d.messages ? d.messages : [];
                    for (let i = msgs.length-1; i>=0; i--) {
                        const m = msgs[i];
                        if (currentUser && String(m.user_id) === String(currentUser.id)) continue;
                        console.debug('chatNotifier: polling -> notifying private message', { id: m.id, user_id: m.user_id, preview: (m.message || '').slice(0,60) });
                        window.showChatNotification({ avatar: (m.users && m.users.profile_picture_url) ? m.users.profile_picture_url : '/images/default-avatar.svg', username: m.username || 'User', message: m.message, chatType: 'private' }, 6000);
                    }
                    lastPrivate = new Date().toISOString();
                }
            }
        } catch (e) { console.debug('chatNotifier: poll() error', e && (e.message || e)); }
    }

    const realtimeOk = await tryRealtime();
    if (!realtimeOk) {
        // start polling with adaptive interval to reduce server load
        let baseInterval = 10000; // 10s when visible
        let hiddenInterval = 30000; // 30s when hidden
        let errorBackoff = 0; // number of consecutive errors
        let timerId = null;

        const scheduleNext = (delay) => {
            if (timerId) clearTimeout(timerId);
            timerId = setTimeout(async () => {
                try {
                    await poll();
                    errorBackoff = 0;
                    // schedule next based on visibility
                    const next = document.hidden ? hiddenInterval : baseInterval;
                    scheduleNext(next);
                } catch (e) {
                    // poll() already logs errors; increase backoff
                    errorBackoff = Math.min(6, errorBackoff + 1);
                    const backoffMs = Math.min(60000, (document.hidden ? hiddenInterval : baseInterval) * Math.pow(2, errorBackoff));
                    console.debug('chatNotifier: scheduling backoff next poll', backoffMs);
                    scheduleNext(backoffMs);
                }
            }, delay);
        };

        // Start initial poll immediately
        scheduleNext(0);

        // Adjust timer when visibility changes
        document.addEventListener('visibilitychange', () => {
            const next = document.hidden ? hiddenInterval : baseInterval;
            console.debug('chatNotifier: visibilitychange, next poll in', next);
            scheduleNext(next);
        });
    }
})();
