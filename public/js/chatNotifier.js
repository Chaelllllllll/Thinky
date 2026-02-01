// Lightweight notifier for pages without the full chat UI.
// Shows toasts for new messages using window.showChatNotification.
(async function(){
    console.debug('chatNotifier: init');
    if (typeof window.showChatNotification !== 'function') {
        console.debug('chatNotifier: showChatNotification not available on this page');
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
                    console.debug('chatNotifier: realtime INSERT payload received', payload && payload.new ? { id: payload.new.id, user_id: payload.new.user_id, message: (payload.new.message || '').slice(0,60) } : payload);
                    try {
                        const n = payload && payload.new ? payload.new : null;
                        if (!n) return;
                        if (currentUser && String(n.user_id) === String(currentUser.id)) return; // skip our own

                        // Only show notification if:
                        // 1. General message (notify everyone except sender)
                        // 2. Private message TO current user (recipient_id matches)
                        // 3. Reply TO current user (reply_to references a message from current user)
                        const isPrivateToMe = n.chat_type === 'private' && currentUser && String(n.recipient_id) === String(currentUser.id);
                        const isGeneral = n.chat_type === 'general';
                        let isReplyToMe = false;

                        // Check if this is a reply to one of my messages
                        if (n.reply_to && currentUser) {
                            try {
                                const replyResp = await fetch(`/api/messages/general?limit=500`, { credentials: 'include' });
                                if (replyResp.ok) {
                                    const replyData = await replyResp.json();
                                    const originalMsg = (replyData.messages || []).find(m => String(m.id) === String(n.reply_to));
                                    if (originalMsg && String(originalMsg.user_id) === String(currentUser.id)) {
                                        isReplyToMe = true;
                                    }
                                }
                            } catch (e) { /* ignore */ }
                        }

                        if (!isGeneral && !isPrivateToMe && !isReplyToMe) return; // skip if not relevant

                        const avatar = (n.profile_picture_url) ? n.profile_picture_url : (n.avatar_url || '/images/default-avatar.svg');
                        const username = n.username || n.display_name || ('User ' + String(n.user_id));
                        const text = n.message || '';
                        const chatType = n.chat_type || (n.recipient_id ? 'private' : 'general');
                        console.debug('chatNotifier: emitting toast for realtime message', { username, chatType, textPreview: text.slice(0,60), isReplyToMe });
                        window.showChatNotification({ avatar, username, message: text, chatType, msgId: n.id, recipientId: n.recipient_id }, 6000);
                    } catch (e) { /* ignore */ }
                })
                .subscribe((status) => {
                    console.debug('chatNotifier: subscription status ->', status);
                    _subscribed = (status === 'SUBSCRIBED' || (status && status.status === 'SUBSCRIBED'));
                });
            console.debug('chatNotifier: realtime subscription attempted');
            _realtimeOk = true;
            return true;
        } catch (e) {
            console.debug('chatNotifier: realtime init failed', e && e.message ? e.message : e);
            _realtimeOk = false;
            _subscribed = false;
            return false;
        }
    }

    // Polling fallback: simple scan for new messages every 10s
    let lastGeneral = new Date().toISOString();
    let lastPrivate = new Date().toISOString();
    const seenMessageIds = new Set();

    // New simplified poll: request messages created after `lastGeneral` every 10s
    async function poll() {
        try {
            // Poll general messages
            const since = encodeURIComponent(lastGeneral);
            const url = `/api/messages/general?since=${since}&limit=100&_=${Date.now()}`;
            console.debug('chatNotifier: scanning messages URL', url);
            const resp = await fetch(url, { credentials: 'include', cache: 'no-store' });
            if (!resp.ok) { console.debug('chatNotifier: scan fetch not ok', resp.status, resp.statusText); return; }
            const d = await resp.json();
            const msgs = d && d.messages ? d.messages : [];

            // Also poll private messages sent TO this user
            let privateMsgs = [];
            if (currentUser && currentUser.id) {
                try {
                    const privResp = await fetch(`/api/messages/private?with=${currentUser.id}&limit=100&_=${Date.now()}`, { credentials: 'include', cache: 'no-store' });
                    if (privResp.ok) {
                        const privData = await privResp.json();
                        const allPriv = privData && privData.messages ? privData.messages : [];
                        // Filter for messages TO current user that are newer than lastPrivate
                        privateMsgs = allPriv.filter(m => 
                            String(m.recipient_id) === String(currentUser.id) && 
                            new Date(m.created_at) > new Date(lastPrivate)
                        );
                    }
                } catch (e) { console.debug('chatNotifier: private poll error', e && e.message); }
            }

            const allMsgs = [...msgs, ...privateMsgs];
            if (allMsgs.length === 0) {
                // no new messages
                return;
            }

            // messages are returned newest-first by server; process oldest->newest
            const ordered = allMsgs.slice().sort((a,b) => new Date(a.created_at) - new Date(b.created_at));
            let newestGeneral = lastGeneral;
            let newestPrivate = lastPrivate;

            for (const m of ordered) {
                if (!m || !m.id) continue;
                if (seenMessageIds.has(m.id)) continue;
                seenMessageIds.add(m.id);
                if (currentUser && String(m.user_id) === String(currentUser.id)) continue; // skip our own

                // Check if this is a reply to me
                let isReplyToMe = false;
                if (m.reply_to && currentUser) {
                    // Check if reply_to_meta exists and belongs to current user
                    if (m.reply_to_meta && String(m.reply_to_meta.user_id) === String(currentUser.id)) {
                        isReplyToMe = true;
                    }
                }

                const isPrivateToMe = m.chat_type === 'private' && currentUser && String(m.recipient_id) === String(currentUser.id);
                const isGeneral = m.chat_type === 'general';

                if (!isGeneral && !isPrivateToMe && !isReplyToMe) continue; // skip if not relevant to me

                const chatTypeLabel = isPrivateToMe ? 'private' : (m.chat_type || 'general');
                console.debug('chatNotifier: scanning -> notifying message', { id: m.id, user_id: m.user_id, chatType: chatTypeLabel, isReplyToMe, preview: (m.message||'').slice(0,60) });
                window.showChatNotification({ 
                    avatar: (m.users && m.users.profile_picture_url) ? m.users.profile_picture_url : '/images/default-avatar.svg', 
                    username: m.username || 'User', 
                    message: m.message, 
                    chatType: chatTypeLabel, 
                    msgId: m.id, 
                    recipientId: m.recipient_id 
                }, 6000);

                if (m.created_at) {
                    if (m.chat_type === 'private') {
                        newestPrivate = (new Date(m.created_at) > new Date(newestPrivate)) ? m.created_at : newestPrivate;
                    } else {
                        newestGeneral = (new Date(m.created_at) > new Date(newestGeneral)) ? m.created_at : newestGeneral;
                    }
                }
            }

            // Advance timestamps
            lastGeneral = newestGeneral;
            lastPrivate = newestPrivate;
        } catch (e) { console.debug('chatNotifier: poll() error', e && (e.message || e)); }
    }

    const realtimeOk = await tryRealtime();
    window._chatNotifier = window._chatNotifier || {};
    window._chatNotifier.realtimeOk = realtimeOk;
    window._chatNotifier.subscribed = _subscribed;

    // Expose a debug helper to manually trigger a poll or print state
    window.debugChatNotifier = async function(action) {
        console.debug('debugChatNotifier:', { action });
        if (!action || action === 'state') {
            console.debug('chatNotifier state', { currentUser, realtimeOk: window._chatNotifier.realtimeOk, subscribed: _subscribed, lastGeneral, lastPrivate });
            return;
        }
        if (action === 'poll') {
            try { await poll(); } catch (e) { console.debug('debugChatNotifier poll error', e && e.message); }
            return;
        }
        if (action === 'realtime') {
            try { const ok = await tryRealtime(); window._chatNotifier.realtimeOk = ok; console.debug('debugChatNotifier realtime ok', ok); } catch(e) { console.debug('debugChatNotifier realtime error', e && e.message); }
            return;
        }
    };

    if (!realtimeOk) {
        // Simplified: poll every 10s regardless of visibility to ensure timely delivery
        const POLL_MS = 10000;
        // initial immediate poll
        poll();
        setInterval(() => {
            try { poll(); } catch (e) { console.debug('chatNotifier: periodic poll error', e && e.message); }
        }, POLL_MS);
    }
})();
