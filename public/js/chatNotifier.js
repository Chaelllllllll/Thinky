// Lightweight notifier for pages without the full chat UI.
// Shows toasts for new messages using window.showChatNotification.
(async function(){
    console.log('chatNotifier: init');
    if (typeof window.showChatNotification !== 'function') {
        console.log('chatNotifier: showChatNotification not available on this page');
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
    let _realtimeOk = false;
    let _subscribed = false;
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
                    console.log('chatNotifier: realtime INSERT payload received', payload && payload.new ? { id: payload.new.id, user_id: payload.new.user_id, message: (payload.new.message || '').slice(0,60) } : payload);
                    try {
                        const n = payload && payload.new ? payload.new : null;
                        if (!n) return;
                        if (currentUser && String(n.user_id) === String(currentUser.id)) return; // skip our own

                        const avatar = (n.profile_picture_url) ? n.profile_picture_url : (n.avatar_url || '/images/default-avatar.svg');
                        const username = n.username || n.display_name || ('User ' + String(n.user_id));
                        const text = n.message || '';
                        const chatType = n.chat_type || (n.recipient_id ? 'private' : 'general');
                        console.log('chatNotifier: emitting toast for realtime message', { username, chatType, textPreview: text.slice(0,60) });
                        window.showChatNotification({ avatar, username, message: text, chatType }, 6000);
                    } catch (e) { /* ignore */ }
                })
                .subscribe((status) => {
                    console.log('chatNotifier: subscription status ->', status);
                    _subscribed = (status === 'SUBSCRIBED' || (status && status.status === 'SUBSCRIBED'));
                });
            console.log('chatNotifier: realtime subscription attempted');
            _realtimeOk = true;
            return true;
        } catch (e) {
            console.log('chatNotifier: realtime init failed', e && e.message ? e.message : e);
            _realtimeOk = false;
            _subscribed = false;
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
                console.log('chatNotifier: polling unread URL', unreadUrl);
                const resp = await fetch(unreadUrl, { credentials: 'include', cache: 'no-store' });
                if (!resp.ok) { console.log('chatNotifier: unread fetch not ok', resp.status, resp.statusText); return; }
                data = await resp.json();
            }

            console.log('chatNotifier: poll result', data);

            // Support two possible shapes: { general, private } OR { messages: [...] }
            if (data && Array.isArray(data.messages)) {
                const msgs = data.messages || [];
                    for (let i = msgs.length-1; i>=0; i--) {
                    const m = msgs[i];
                    if (currentUser && String(m.user_id) === String(currentUser.id)) continue;
                    console.log('chatNotifier: poll -> notifying from messages array', { id: m.id, preview: (m.message||'').slice(0,60) });
                    window.showChatNotification({ avatar: (m.users && m.users.profile_picture_url) ? m.users.profile_picture_url : '/images/default-avatar.svg', username: m.username || 'User', message: m.message, chatType: m.chat_type || 'general' }, 6000);
                }
                // update last seen timestamps to now after notifying
                lastGeneral = new Date().toISOString();
                lastPrivate = new Date().toISOString();
                return;
            }

            const g = data && data.general ? parseInt(data.general,10) : 0;
            const p = data && data.private ? parseInt(data.private,10) : 0;
            if (g > 0) {
                // fetch latest general messages and notify (cache-busting + no-store)
                const r = await fetch('/api/messages/general?limit=3&_=' + Date.now(), { credentials: 'include', cache: 'no-store' });
                if (r.ok) {
                    const d = await r.json();
                    const msgs = d && d.messages ? d.messages : [];
                    if (msgs.length === 0) {
                        console.log('chatNotifier: unread indicated new general messages but fetch returned none; trying /api/_last_message');
                        try {
                            const lastResp = await fetch('/api/_last_message', { credentials: 'include', cache: 'no-store' });
                            if (lastResp.ok) {
                                const lastData = await lastResp.json();
                                const m = lastData && lastData.message ? lastData.message : null;
                                if (m && !(currentUser && String(m.user_id) === String(currentUser.id))) {
                                    console.log('chatNotifier: notifying from debug last_message', { id: m.id, preview: (m.message||'').slice(0,60) });
                                    window.showChatNotification({ avatar: (m.profile_picture_url || '/images/default-avatar.svg'), username: m.username || 'User', message: m.message, chatType: m.chat_type || 'general' }, 6000);
                                }
                            }
                        } catch (e) { console.log('chatNotifier: /api/_last_message fetch error', e && e.message); }
                    } else {
                        for (let i = msgs.length-1; i>=0; i--) {
                            const m = msgs[i];
                            if (currentUser && String(m.user_id) === String(currentUser.id)) continue;
                            console.log('chatNotifier: polling -> notifying general message', { id: m.id, user_id: m.user_id, preview: (m.message || '').slice(0,60) });
                            window.showChatNotification({ avatar: (m.users && m.users.profile_picture_url) ? m.users.profile_picture_url : '/images/default-avatar.svg', username: m.username || 'User', message: m.message, chatType: 'general' }, 6000);
                        }
                    }
                    lastGeneral = new Date().toISOString();
                } else {
                    console.log('chatNotifier: fetch general messages failed', r.status, r.statusText);
                }
            }
            if (p > 0) {
                // For private, we simply fetch private messages
                const r = await fetch('/api/messages/private?limit=3&_=' + Date.now(), { credentials: 'include', cache: 'no-store' });
                if (r.ok) {
                    const d = await r.json();
                    const msgs = d && d.messages ? d.messages : [];
                    for (let i = msgs.length-1; i>=0; i--) {
                        const m = msgs[i];
                        if (currentUser && String(m.user_id) === String(currentUser.id)) continue;
                        console.log('chatNotifier: polling -> notifying private message', { id: m.id, user_id: m.user_id, preview: (m.message || '').slice(0,60) });
                        window.showChatNotification({ avatar: (m.users && m.users.profile_picture_url) ? m.users.profile_picture_url : '/images/default-avatar.svg', username: m.username || 'User', message: m.message, chatType: 'private' }, 6000);
                    }
                    lastPrivate = new Date().toISOString();
                }
            }
        } catch (e) { console.log('chatNotifier: poll() error', e && (e.message || e)); }
    }

    const realtimeOk = await tryRealtime();
    window._chatNotifier = window._chatNotifier || {};
    window._chatNotifier.realtimeOk = realtimeOk;
    window._chatNotifier.subscribed = _subscribed;

    // Expose a debug helper to manually trigger a poll or print state
    window.debugChatNotifier = async function(action) {
        console.log('debugChatNotifier:', { action });
        if (!action || action === 'state') {
            console.log('chatNotifier state', { currentUser, realtimeOk: window._chatNotifier.realtimeOk, subscribed: _subscribed, lastGeneral, lastPrivate });
            return;
        }
        if (action === 'poll') {
            try { await poll(); } catch (e) { console.log('debugChatNotifier poll error', e && e.message); }
            return;
        }
        if (action === 'realtime') {
            try { const ok = await tryRealtime(); window._chatNotifier.realtimeOk = ok; console.log('debugChatNotifier realtime ok', ok); } catch(e) { console.log('debugChatNotifier realtime error', e && e.message); }
            return;
        }
    };

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
                    console.log('chatNotifier: scheduling backoff next poll', backoffMs);
                    scheduleNext(backoffMs);
                }
            }, delay);
        };

        // Start initial poll immediately
        scheduleNext(0);

        // Adjust timer when visibility changes
        document.addEventListener('visibilitychange', () => {
            const next = document.hidden ? hiddenInterval : baseInterval;
            console.log('chatNotifier: visibilitychange, next poll in', next);
            scheduleNext(next);
        });
    }
})();
