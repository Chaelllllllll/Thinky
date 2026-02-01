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

                        // Check if this is a private message to current user
                        const isPrivateToMe = n.recipient_id && currentUser && String(n.recipient_id) === String(currentUser.id);
                        
                        // Check if this is a reply to current user's message
                        const isReplyToMe = n.reply_to && currentUser; // will verify in fetch below
                        
                        // Show notification if: general message, private to me, or potentially a reply to me
                        if (!isPrivateToMe && !isReplyToMe && n.chat_type !== 'general') return;

                        // For replies, verify it's actually replying to current user
                        if (isReplyToMe && n.reply_to) {
                            try {
                                const replyResp = await fetch(`/api/messages/${encodeURIComponent(n.reply_to)}`, { credentials: 'include' });
                                if (replyResp.ok) {
                                    const replyData = await replyResp.json();
                                    const originalMsg = replyData && replyData.message;
                                    if (!originalMsg || String(originalMsg.user_id) !== String(currentUser.id)) {
                                        // Not replying to current user
                                        if (!isPrivateToMe && n.chat_type !== 'general') return;
                                    }
                                }
                            } catch (e) { /* ignore verification error */ }
                        }

                        const avatar = (n.profile_picture_url) ? n.profile_picture_url : (n.avatar_url || '/images/default-avatar.svg');
                        const username = n.username || n.display_name || ('User ' + String(n.user_id));
                        const text = n.message || '';
                        const chatType = n.chat_type || (n.recipient_id ? 'private' : 'general');
                        console.debug('chatNotifier: emitting toast for realtime message', { username, chatType, textPreview: text.slice(0,60) });
                        window.showChatNotification({ avatar, username, message: text, chatType, msgId: n.id, recipientId: n.recipient_id, withUser: n.user_id, userId: n.user_id }, 6000);
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

    // Poll for both general and private messages, plus check for replies to current user
    async function poll() {
        try {
            // Poll general messages
            const sinceGeneral = encodeURIComponent(lastGeneral);
            const urlGeneral = `/api/messages/general?since=${sinceGeneral}&limit=100&_=${Date.now()}`;
            console.debug('chatNotifier: scanning general messages URL', urlGeneral);
            const respGeneral = await fetch(urlGeneral, { credentials: 'include', cache: 'no-store' });
            if (respGeneral.ok) {
                const d = await respGeneral.json();
                const msgs = d && d.messages ? d.messages : [];
                if (Array.isArray(msgs) && msgs.length > 0) {
                    const ordered = msgs.slice().sort((a,b) => new Date(a.created_at) - new Date(b.created_at));
                    let newestTs = lastGeneral;
                    for (const m of ordered) {
                        if (!m || !m.id) continue;
                        if (seenMessageIds.has(m.id)) continue;
                        seenMessageIds.add(m.id);
                        if (currentUser && String(m.user_id) === String(currentUser.id)) continue; // skip our own
                        
                        // Check if this is a reply to current user's message
                        let isReplyToMe = false;
                        if (m.reply_to && m.reply_to_meta && currentUser) {
                            isReplyToMe = String(m.reply_to_meta.user_id) === String(currentUser.id);
                        }
                        
                        // Show notification for general messages or replies to me
                        if (m.chat_type === 'general' || isReplyToMe) {
                            console.debug('chatNotifier: scanning -> notifying general message', { id: m.id, user_id: m.user_id, isReplyToMe, preview: (m.message||'').slice(0,60) });
                            window.showChatNotification({ avatar: (m.users && m.users.profile_picture_url) ? m.users.profile_picture_url : '/images/default-avatar.svg', username: m.username || 'User', message: m.message, chatType: m.chat_type || 'general', msgId: m.id, recipientId: m.recipient_id, withUser: m.user_id, userId: m.user_id }, 6000);
                        }
                        
                        if (m.created_at) newestTs = (new Date(m.created_at) > new Date(newestTs)) ? m.created_at : newestTs;
                    }
                    lastGeneral = newestTs || new Date().toISOString();
                }
            }
            
            // Poll private messages
            const sincePrivate = encodeURIComponent(lastPrivate);
            const urlPrivate = `/api/messages/private-inbox?since=${sincePrivate}&limit=100&_=${Date.now()}`;
            console.debug('chatNotifier: scanning private messages URL', urlPrivate);
            const respPrivate = await fetch(urlPrivate, { credentials: 'include', cache: 'no-store' });
            if (respPrivate.ok) {
                const d = await respPrivate.json();
                const msgs = d && d.messages ? d.messages : [];
                if (Array.isArray(msgs) && msgs.length > 0) {
                    const ordered = msgs.slice().sort((a,b) => new Date(a.created_at) - new Date(b.created_at));
                    let newestTs = lastPrivate;
                    for (const m of ordered) {
                        if (!m || !m.id) continue;
                        if (seenMessageIds.has(m.id)) continue;
                        seenMessageIds.add(m.id);
                        if (currentUser && String(m.user_id) === String(currentUser.id)) continue; // skip our own
                        
                        // Only notify if this private message is TO current user
                        if (m.recipient_id && currentUser && String(m.recipient_id) === String(currentUser.id)) {
                            console.debug('chatNotifier: scanning -> notifying private message', { id: m.id, user_id: m.user_id, recipient_id: m.recipient_id, preview: (m.message||'').slice(0,60) });
                            window.showChatNotification({ avatar: (m.users && m.users.profile_picture_url) ? m.users.profile_picture_url : '/images/default-avatar.svg', username: m.username || 'User', message: m.message, chatType: 'private', msgId: m.id, recipientId: m.recipient_id, withUser: m.user_id, userId: m.user_id }, 6000);
                        }
                        
                        if (m.created_at) newestTs = (new Date(m.created_at) > new Date(newestTs)) ? m.created_at : newestTs;
                    }
                    lastPrivate = newestTs || new Date().toISOString();
                }
            }
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
        // If the full chat page is open and already polling, avoid running
        // the lightweight notifier polling to prevent duplicate fetches.
        if (window._chatPollingActive) {
            console.debug('chatNotifier: full chat polling active, skipping notifier poll');
        } else {
            // Simplified: poll every 10s regardless of visibility to ensure timely delivery
            const POLL_MS = 10000;
            // initial immediate poll
            poll();
            setInterval(() => {
                try { poll(); } catch (e) { console.debug('chatNotifier: periodic poll error', e && e.message); }
            }, POLL_MS);
        }
    }
})();
