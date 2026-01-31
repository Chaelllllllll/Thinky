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
                    try {
                        const n = payload && payload.new ? payload.new : null;
                        if (!n) return;
                        if (currentUser && String(n.user_id) === String(currentUser.id)) return; // skip our own

                        const avatar = (n.profile_picture_url) ? n.profile_picture_url : (n.avatar_url || '/images/default-avatar.svg');
                        const username = n.username || n.display_name || ('User ' + String(n.user_id));
                        const text = n.message || '';
                        const chatType = n.chat_type || (n.recipient_id ? 'private' : 'general');
                        window.showChatNotification({ avatar, username, message: text, chatType }, 6000);
                    } catch (e) { /* ignore */ }
                })
                .subscribe((status) => {
                    // no-op
                });
            return true;
        } catch (e) {
            return false;
        }
    }

    // Polling fallback: check unread counts and fetch latest messages when changed
    let lastGeneral = new Date().toISOString();
    let lastPrivate = new Date().toISOString();

    async function poll() {
        try {
            const lg = encodeURIComponent(lastGeneral);
            const lp = encodeURIComponent(lastPrivate);
            const resp = await fetch(`/api/messages/unread?lastSeenGeneral=${lg}&lastSeenPrivate=${lp}`, { credentials: 'include' });
            if (!resp.ok) return;
            const data = await resp.json();
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
                        window.showChatNotification({ avatar: (m.users && m.users.profile_picture_url) ? m.users.profile_picture_url : '/images/default-avatar.svg', username: m.username || 'User', message: m.message, chatType: 'private' }, 6000);
                    }
                    lastPrivate = new Date().toISOString();
                }
            }
        } catch (e) { /* ignore */ }
    }

    const realtimeOk = await tryRealtime();
    if (!realtimeOk) {
        // start polling every 5s
        poll();
        setInterval(poll, 5000);
    }
})();
