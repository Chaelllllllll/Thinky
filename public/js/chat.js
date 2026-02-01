/**
 * Chat JavaScript
 * Handles real-time chat functionality
 */

let currentChatType = 'general';
let currentUser = null;
let messages = [];
let messagesSubscription = null;
let currentRecipientId = null;
let currentReplyTo = null;
let currentRecipientName = null;

// Client-side blacklist and warning/mute fallback (mirrors server rules).
const CLIENT_BLACKLIST = ['badword1','badword2','slur']; // keep in sync with server MESSAGE_BLACKLIST
const CLIENT_MAX_WARNINGS = 3;
const CLIENT_MUTE_MS = 60 * 60 * 1000; // 1 hour

function clientNormalizeForMatch(text) {
    if (!text) return '';
    let s = String(text).normalize('NFKD').replace(/\p{Diacritic}/gu, '');
    s = s.toLowerCase();
    s = s.replace(/[^a-z0-9]+/g, ' ');
    s = s.replace(/\s+/g, ' ').trim();
    return s;
}

function clientHasBlacklistedWord(text) {
    const norm = clientNormalizeForMatch(text);
    if (!norm) return false;
    for (const raw of CLIENT_BLACKLIST) {
        if (!raw) continue;
        const esc = raw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const re = new RegExp('\\b' + esc + '\\b', 'i');
        if (re.test(norm)) return true;
    }
    return false;
}

// Client-side persistent warnings/mute removed — server is authoritative.
// LocalStorage-based warning/mute state was intentionally removed to
// rely on DB-backed moderation persisted by the server.

// Note: Supabase realtime requires configuration on the backend
// For this demo, we'll use polling instead of realtime subscriptions

document.addEventListener('DOMContentLoaded', () => {
    loadCurrentUser();
    loadMessages();

    // If we were navigated to chat with a scrollTo param, capture it so we can scroll after messages load
    try {
        const params = new URLSearchParams(window.location.search);
        const scrollTo = params.get('scrollTo') || null;
        if (scrollTo) {
            window._pendingScrollMessageId = String(scrollTo);
        }
    } catch (e) { /* ignore */ }

    // If a query param `with` is present, start a private chat with that user id
    try {
        const params = new URLSearchParams(window.location.search);
        const withId = params.get('with') || params.get('withUser') || params.get('user');
        if (withId) {
            // Try to load the target user's public info to get a display name
            fetch(`/api/users/${encodeURIComponent(withId)}`).then(r => {
                if (!r.ok) return null;
                return r.json().then(d => d.user).catch(() => null);
            }).then(user => {
                const name = (user && (user.display_name || user.username)) ? (user.display_name || user.username) : 'User';
                // set recipient and start private chat
                startPrivateChat(withId, name);
            }).catch(() => {
                startPrivateChat(withId, 'User');
            });
        }
    } catch (e) {
        // ignore
    }

    // Poll for new messages with adaptive interval to reduce server load
    (function startAdaptiveMessagesPolling(){
        // Mark that the full chat UI has an active polling loop so
        // lightweight notifiers don't also poll and cause duplicate requests.
        try { window._chatPollingActive = true; } catch (e) {}
        let baseInterval = 5000; // 5s when visible
        let hiddenInterval = 20000; // 20s when hidden
        let errorBackoff = 0;
        let timer = null;

        const schedule = (delay) => {
            if (timer) clearTimeout(timer);
            timer = setTimeout(async () => {
                try {
                    await loadMessages(true);
                    errorBackoff = 0;
                    schedule(document.hidden ? hiddenInterval : baseInterval);
                } catch (e) {
                    errorBackoff = Math.min(6, errorBackoff + 1);
                    const backoff = Math.min(60000, (document.hidden ? hiddenInterval : baseInterval) * Math.pow(2, errorBackoff));
                    console.debug('chat.js: loadMessages error, backing off next poll to', backoff);
                    schedule(backoff);
                }
            }, delay);
        };

        schedule(0);
        document.addEventListener('visibilitychange', () => {
            schedule(document.hidden ? hiddenInterval : baseInterval);
        });
        // Ensure flag is cleared when page unloads
        window.addEventListener('beforeunload', () => { try { window._chatPollingActive = false; } catch (e) {} });
    })();

    // Try to initialize realtime subscriptions (Supabase) for instant updates
    try {
        initRealtime();
    } catch (e) { /* ignore */ }

    // Update online status every 30 seconds
    setInterval(updateOnlineStatus, 30000);
    updateOnlineStatus();

    // Start polling for unread counts — prefer shared polling if available
    if (typeof window.startSharedUnreadPolling === 'function') {
        window.startSharedUnreadPolling();
    } else {
        startUnreadPolling();
    }

    // Enter key to send message
    document.getElementById('messageInput').addEventListener('keypress', (e) => {
        if (e.key === 'Enter') {
            sendMessage();
        }
    });
    // Ensure input/send state reflects current chat selection
    updateChatInputState();
});

// Realtime (Supabase) integration -------------------------------------------------
let _realtimeInitialized = false;
function loadScript(src) {
    return new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = src;
        s.async = true;
        s.onload = () => resolve();
        s.onerror = () => reject(new Error('Failed to load ' + src));
        document.head.appendChild(s);
    });
}

async function initRealtime() {
    if (_realtimeInitialized) return;

    // Look for creds injected into the page by the server or window.ENV
    const env = (window && window.ENV) ? window.ENV : window;
    const url = env.SUPABASE_URL || env.SUPABASE_URL || (window.SUPABASE_URL || null);
    const key = env.SUPABASE_ANON_KEY || env.SUPABASE_KEY || (window.SUPABASE_KEY || null);
    if (!url || !key) {
        // no client creds available — skip realtime
        return;
    }

    // Load Supabase JS (UMD) if not already present
    if (!window.supabase || !window.supabase.createClient) {
        try {
            await loadScript('https://cdn.jsdelivr.net/npm/@supabase/supabase-js/dist/umd/supabase.min.js');
        } catch (e) {
            console.warn('Could not load Supabase client for realtime:', e && e.message ? e.message : e);
            return;
        }
    }

    try {
        window._supabaseRealtime = window.supabase.createClient(url, key);

        // subscribe to inserts on `messages` table
        const chan = window._supabaseRealtime.channel('public:messages')
            .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'messages' }, (payload) => {
                // When a new message is inserted, refresh messages (silent) so
                // the UI receives the fully joined payload from the API and
                // our notification logic runs as normal.
                try { loadMessages(true); } catch (e) { /* ignore */ }
            })
            .subscribe((status) => {
                if (status === 'SUBSCRIBED') {
                    _realtimeInitialized = true;
                    console.info('Realtime messages subscription active');
                }
            });
    } catch (e) {
        console.warn('Realtime init failed:', e && e.message ? e.message : e);
    }
}

// ------- Unread badge helpers -------
const LAST_SEEN_GENERAL_KEY = 'chat_last_seen_general';
const LAST_SEEN_PRIVATE_KEY = 'chat_last_seen_private';
let unreadPollInterval = null;

function getLastSeen(key) {
    // Default to now so existing messages are not treated as unread on first load
    return localStorage.getItem(key) || new Date().toISOString();
}

function setLastSeen(key, iso) {
    try { localStorage.setItem(key, iso); } catch (e) { /* ignore */ }
}

function updateUnreadBadges(counts) {
    const g = counts && counts.general ? parseInt(counts.general, 10) : 0;
    const p = counts && counts.private ? parseInt(counts.private, 10) : 0;

    const gEl = document.getElementById('generalUnreadBadge');
    const pEl = document.getElementById('personalUnreadBadge');

    if (gEl) {
        if (g > 0) { gEl.style.display = 'inline-block'; gEl.textContent = g > 99 ? '99+' : String(g); }
        else { gEl.style.display = 'none'; }
    }
    if (pEl) {
        if (p > 0) { pEl.style.display = 'inline-block'; pEl.textContent = p > 99 ? '99+' : String(p); }
        else { pEl.style.display = 'none'; }
    }
}

async function pollUnreadCounts() {
    if (!currentUser) return;
    try {
        const lastSeenGeneral = encodeURIComponent(getLastSeen(LAST_SEEN_GENERAL_KEY));
        const lastSeenPrivate = encodeURIComponent(getLastSeen(LAST_SEEN_PRIVATE_KEY));
        const resp = await fetch(`/api/messages/unread?lastSeenGeneral=${lastSeenGeneral}&lastSeenPrivate=${lastSeenPrivate}`, { credentials: 'include' });
        if (!resp.ok) return;
        const data = await resp.json();
        updateUnreadBadges(data);
    } catch (e) {
        // ignore polling errors
    }
}

function startUnreadPolling() {
    if (unreadPollInterval) clearInterval(unreadPollInterval);
    // Ensure keys exist (default to now)
    setLastSeen(LAST_SEEN_GENERAL_KEY, getLastSeen(LAST_SEEN_GENERAL_KEY));
    setLastSeen(LAST_SEEN_PRIVATE_KEY, getLastSeen(LAST_SEEN_PRIVATE_KEY));
    pollUnreadCounts();
    unreadPollInterval = setInterval(pollUnreadCounts, 5000);
}


function updateChatInputState() {
    const input = document.getElementById('messageInput');
    const sendBtn = document.getElementById('sendBtn');
    const closeBtn = document.getElementById('closePrivateBtn');
    if (!input || !sendBtn) return;

    // Allow sending for non-private chats (general/online).
    if (currentChatType !== 'private') {
        input.disabled = false;
        sendBtn.disabled = false;
        input.placeholder = 'Type your message...';
        if (closeBtn) closeBtn.style.display = 'none';
        return;
    }

    // For private chats, require a selected recipient.
    if (currentChatType === 'private' && !currentRecipientId) {
        input.disabled = true;
        sendBtn.disabled = true;
        input.placeholder = 'Select a user to start a private chat.';
        if (closeBtn) closeBtn.style.display = 'none';
        return;
    }

    // Private chat with recipient selected: allow sending and show close button.
    input.disabled = false;
    sendBtn.disabled = false;
    input.placeholder = 'Type your message...';
    if (closeBtn) closeBtn.style.display = 'inline-block';
}

async function loadCurrentUser() {
    try {
        const response = await fetch('/api/auth/me', { credentials: 'include' });
        if (!response.ok) {
            window.location.href = '/login';
            return;
        }

        const data = await response.json();
        currentUser = data.user;
    } catch (error) {
        console.error('Error loading user:', error);
        window.location.href = '/login';
    }
}

async function loadMessages(silent = false) {
    try {
        let url = `/api/messages/${currentChatType}?limit=100`;
        if (currentChatType === 'private') {
            if (!currentRecipientId) {
                if (!silent) {
                    document.getElementById('chatMessages').innerHTML = `<div style="text-align:center;padding:40px;color:var(--dark-gray);">Select a user to start a private chat.</div>`;
                }
                return;
            }
            url += `&with=${currentRecipientId}`;
        }

        const response = await fetch(url, { credentials: 'include' });

        if (response.status === 401) {
            // Not authenticated: redirect to login so the UI doesn't hang
            console.warn('Not authenticated when loading messages');
            window.location.href = '/login';
            return;
        }

        if (!response.ok) throw new Error('Failed to load messages');

        const data = await response.json();
        const fetched = (data && Array.isArray(data.messages)) ? data.messages : [];

        // Only update if there are new messages (or show empty state)
        if (JSON.stringify(fetched) !== JSON.stringify(messages)) {
            // detect new messages (simple heuristic using id if present, otherwise created_at+user+text)
            const newMessages = fetched.filter(f => {
                return !messages.some(m => {
                    if (m && f && m.id && f.id) return String(m.id) === String(f.id);
                    return m && f && m.created_at === f.created_at && String(m.user_id) === String(f.user_id) && m.message === f.message;
                });
            });

            // update state then display
            messages = fetched;
            displayMessages(silent);

            // Notify about new messages when on dashboard/index/profile/user pages
            try {
                const path = (window.location.pathname || '').toLowerCase();
                const notifyPages = ['/dashboard.html', '/index.html', '/', '/profile.html', '/user.html'];
                const onNotifyPage = notifyPages.some(p => path === p || path.endsWith(p) || (p === '/' && path === '/'));

                if (onNotifyPage && typeof window.showChatNotification === 'function' && currentUser) {
                    newMessages.forEach(msg => {
                        // skip notifications for messages sent by the current user
                        if (currentUser && String(msg.user_id) === String(currentUser.id)) return;

                        // Check if this is a private message to current user
                        const isPrivateToMe = msg.recipient_id && String(msg.recipient_id) === String(currentUser.id);
                        
                        // Check if this is a reply to current user's message
                        const isReplyToMe = msg.reply_to_meta && String(msg.reply_to_meta.user_id) === String(currentUser.id);
                        
                        // Only show notification if: general message, private to me, or reply to me
                        const chatType = msg.chat_type || (msg.recipient_id ? 'private' : 'general');
                        if (chatType !== 'general' && !isPrivateToMe && !isReplyToMe) return;

                        const avatarUrl = (msg.users && msg.users.profile_picture_url) ? msg.users.profile_picture_url : '/images/default-avatar.svg';
                        const username = msg.username || msg.display_name || 'User';
                        const body = msg.message || '';

                        try {
                            window.showChatNotification({ avatar: avatarUrl, username, message: body, chatType, msgId: msg.id, recipientId: msg.recipient_id });
                        } catch (e) { /* ignore */ }
                    });
                }
            } catch (e) { /* ignore */ }
        } else if (messages.length === 0) {
            // Ensure empty state is shown when there are zero messages
            displayMessages(silent);
        }
    } catch (error) {
        console.error('Error loading messages:', error);
        if (!silent) {
            document.getElementById('chatMessages').innerHTML = `
                <div style="text-align: center; padding: 40px 20px; color: var(--dark-gray);">
                    <i class="bi bi-exclamation-circle" style="font-size: 3rem; color: var(--danger);"></i>
                    <p style="margin-top: 16px;">Failed to load messages</p>
                </div>
            `;
        }
    }
}

function displayMessages(preserveScroll = false) {
    const container = document.getElementById('chatMessages');
    const wasScrolledToBottom = container.scrollHeight - container.scrollTop <= container.clientHeight + 50;

    if (messages.length === 0) {
        container.innerHTML = `
            <div style="text-align: center; padding: 40px 20px; color: var(--dark-gray);">
                <i class="bi bi-chat-text" style="font-size: 3rem; color: var(--primary-pink);"></i>
                <p style="margin-top: 16px;">No messages yet. Start the conversation!</p>
            </div>
        `;
        return;
    }

    container.innerHTML = messages.map(msg => {
        const isSelf = currentUser && String(msg.user_id) === String(currentUser.id);
        const avatarUrl = (msg.users && msg.users.profile_picture_url) ? msg.users.profile_picture_url : '/images/default-avatar.svg';
        const who = escapeHtml(msg.username || 'User');
        const avatarImg = `<img src="${avatarUrl}" onerror="this.onerror=null;this.src='/images/default-avatar.svg'" alt="avatar" class="msg-avatar"/>`;
        const profileLink = `/user.html?user=${encodeURIComponent(msg.user_id)}`;
        const avatar = `<a href="${profileLink}" class="msg-avatar-link" title="${who}">${avatarImg}</a>`;
        const time = formatTime(msg.created_at);
        const replyTargetId = (msg.reply_to_meta && msg.reply_to_meta.id) ? ('msg-' + String(msg.reply_to_meta.id).replace(/[^a-zA-Z0-9-_:.]/g, '')) : '';

        // Attach id to each message so we can scroll to it from notifications
        const safeId = msg && msg.id ? String(msg.id).replace(/[^a-zA-Z0-9-_:.]/g, '') : '';
        const idAttr = safeId ? `id="msg-${safeId}"` : '';
        // build header: normally show author; for replies show label above the recipient snippet
        let headerHtml = `<div class="msg-header"><span class="msg-author">${who}</span></div>`;
        let replySnippetHtml = '';
        if (msg.reply_to_meta) {
            const repliedName = escapeHtml(msg.reply_to_meta.username || '');
            const repliedSnippet = escapeHtml(String(msg.reply_to_meta.message || '')).substring(0,120);
            if (currentUser && currentUser.id && String(currentUser.id) === String(msg.user_id)) {
                // For messages you sent (the replier), label as 'you replied' and show recipient snippet below
                headerHtml = `<div class="msg-header"><span class="msg-author">you replied</span></div>`;
                replySnippetHtml = `<div class="msg-reply-preview inline" data-target="${replyTargetId}"><span class="reply-indicator" aria-hidden="true">↩</span>${repliedSnippet}</div>`;
            } else {
                // For others' messages, label as '<author> replied' and show recipient snippet below
                headerHtml = `<div class="msg-header"><span class="msg-author">${who} replied</span></div>`;
                replySnippetHtml = `<div class="msg-reply-preview inline" data-target="${replyTargetId}"><span class="reply-indicator" aria-hidden="true">↩</span>${repliedSnippet}</div>`;
            }
        }

        return `
        <div ${idAttr} class="chat-message ${isSelf ? 'msg-self' : ''}" data-username="${who}">
            ${avatar}
            <div class="msg-body">
                ${headerHtml}
                ${replySnippetHtml}
                <div class="msg-row">
                    <div class="msg-bubble ${isSelf ? 'right' : 'left'}">
                        <div class="msg-text">${escapeHtml(msg.message)}</div>
                    </div>
                    <div class="msg-actions-inline" aria-hidden="true">
                        <button class="msg-more-btn" aria-label="more">⋯</button>
                        <div class="msg-actions-menu" role="menu">
                            <button class="msg-reply-btn" role="menuitem">Reply</button>
                            <button class="msg-report-btn" role="menuitem">Report</button>
                        </div>
                    </div>
                </div>
                <div class="msg-time-below">${time}</div>
            </div>
        </div>
        `;
    }).join('');

    // Auto-scroll to bottom if user was already at bottom or if it's a new load
    if (!preserveScroll || wasScrolledToBottom) {
        container.scrollTop = container.scrollHeight;
    }

    // Attach interaction handlers: clicking a message reveals time and actions
    try {
        const msgEls = container.querySelectorAll('.chat-message');
        msgEls.forEach(el => {
            const mid = el.getAttribute('id');
            const msg = (mid && mid.startsWith('msg-')) ? messages.find(m => String(m.id) === mid.replace(/^msg-/, '')) : null;
            el.addEventListener('click', (e) => {
                e.stopPropagation();
                // deselect others
                document.querySelectorAll('.chat-message.selected').forEach(x => { if (x !== el) x.classList.remove('selected'); });
                el.classList.toggle('selected');
                // hide any open action menus
                document.querySelectorAll('.msg-actions-menu.show').forEach(m => m.classList.remove('show'));
            });

            const more = el.querySelector('.msg-more-btn');
            const menu = el.querySelector('.msg-actions-menu');
            if (more && menu) {
                more.addEventListener('click', (ev) => {
                    ev.stopPropagation();
                    menu.classList.toggle('show');
                });
            }

            // wire reply preview click -> scroll to target message
            const preview = el.querySelector('.msg-reply-preview');
            if (preview) {
                // try to set avatar for reply (best-effort: fetch user avatar if available)
                (async () => {
                    try {
                        const rt = msg && msg.reply_to_meta;
                        const img = preview.querySelector('.reply-avatar');
                        if (img && rt && rt.user_id) {
                            const r = await fetch('/api/users/' + encodeURIComponent(rt.user_id));
                            if (r.ok) {
                                const d = await r.json();
                                const url = d && d.user && d.user.profile_picture_url ? d.user.profile_picture_url : null;
                                if (url) img.src = url;
                            }
                        }
                    } catch (e) { /* ignore */ }
                })();

                preview.addEventListener('click', (ev) => {
                    ev.stopPropagation();
                    const targetId = preview.getAttribute('data-target');
                    if (!targetId) return;
                    const targetEl = document.getElementById(targetId);
                    if (targetEl) {
                        targetEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
                        targetEl.classList.add('msg-highlight');
                        setTimeout(() => { try { targetEl.classList.remove('msg-highlight'); } catch (e) {} }, 3000);
                    }
                });
            }

            const replyBtn = el.querySelector('.msg-reply-btn');
            if (replyBtn) {
                replyBtn.addEventListener('click', (ev) => {
                    ev.stopPropagation();
                    // Show reply banner and set reply target
                    const author = el.getAttribute('data-username') || '';
                    const messageText = msg ? (msg.message || '') : '';
                    const mid = el.getAttribute('id'); // id like msg-<safeId>
                    if (mid && mid.startsWith('msg-')) {
                        currentReplyTo = mid.replace(/^msg-/, '');
                        if (typeof showReplyBanner === 'function') showReplyBanner(author, messageText);
                    }
                    const input = document.getElementById('messageInput');
                    if (input) input.focus();
                    // close menu
                    if (menu) menu.classList.remove('show');
                });
            }
            const reportBtn = el.querySelector('.msg-report-btn');
            if (reportBtn) {
                reportBtn.addEventListener('click', (ev) => {
                    ev.stopPropagation();
                    const mid = el.getAttribute('id');
                    if (mid && mid.startsWith('msg-')) {
                        const messageId = mid.replace(/^msg-/, '');
                        if (window.openMessageReportModal) window.openMessageReportModal(messageId);
                    }
                    if (menu) menu.classList.remove('show');
                });
            }
        });

        // click outside to clear selections and menus
        document.addEventListener('click', () => {
            document.querySelectorAll('.chat-message.selected').forEach(x => x.classList.remove('selected'));
            document.querySelectorAll('.msg-actions-menu.show').forEach(m => m.classList.remove('show'));
        });
    } catch (e) { /* ignore */ }

    // Mark messages as seen for the current view
    try {
        const now = new Date().toISOString();
        if (currentChatType === 'general') {
            setLastSeen(LAST_SEEN_GENERAL_KEY, now);
        } else if (currentChatType === 'private') {
            // Mark private aggregate as seen when viewing a private thread
            setLastSeen(LAST_SEEN_PRIVATE_KEY, now);
        }
        // Refresh badges after marking
        pollUnreadCounts();
    } catch (e) { /* ignore */ }

    // If a pending scroll is requested, try to find and scroll to it
    tryScrollPending();
}

function tryScrollPending() {
    try {
        const id = window._pendingScrollMessageId;
        if (!id) return;
        const el = document.getElementById('msg-' + id);
        if (el) {
            el.scrollIntoView({ behavior: 'smooth', block: 'center' });
            // briefly highlight
            el.classList.add('msg-highlight');
            setTimeout(() => { try { el.classList.remove('msg-highlight'); } catch(e){} }, 3000);
            // clear pending
            window._pendingScrollMessageId = null;
        }
    } catch (e) { /* ignore */ }
}

async function sendMessage() {
    const input = document.getElementById('messageInput');
    const message = input.value.trim();

    if (!message) return;

    // Client-side sanitization to avoid sending HTML or control chars
    let clean = String(message).trim();
    clean = clean.replace(/<[^>]*>/g, '');
    clean = clean.replace(/[\x00-\x1F\x7F]/g, '');
    if (clean.length > 1000) clean = clean.substring(0, 1000);

    // No client-side blocking for blacklisted words — reports are used instead.

    // Prevent sending private messages without a recipient
    if (currentChatType === 'private' && !currentRecipientId) {
        alert('Please select a user to start a private chat.');
        return;
    }

    // Prevent sending messages to yourself
    if (currentChatType === 'private' && currentRecipientId && currentUser && String(currentRecipientId) === String(currentUser.id)) {
        window.showAlert && window.showAlert('error', 'You cannot send messages to yourself.', 3000);
        return;
    }

    try {
        const body = { message: clean, chat_type: currentChatType };
        if (currentChatType === 'private' && currentRecipientId) {
            body.recipient_id = currentRecipientId;
        }
        // include reply reference if set
        if (currentReplyTo) {
            body.reply_to = currentReplyTo;
        }

        const response = await fetch('/api/messages', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            credentials: 'include',
            body: JSON.stringify(body)
        });
        // Try to parse response JSON for helpful errors
        let respJson = null;
        try { respJson = await response.json(); } catch (e) { /* ignore */ }

        if (!response.ok) {
                if (response.status === 401) {
                // Not authenticated
                window.location.href = '/login';
                return;
            }
            if (response.status === 403) {
                // Muted or forbidden — server is authoritative; show server message including remaining duration when provided.
                let errorMsg = (respJson && respJson.error) ? respJson.error : 'You are not allowed to send messages.';
                try {
                    if (respJson && respJson.muted_until) {
                        const until = new Date(respJson.muted_until);
                        const now = new Date();
                        if (until > now) {
                            const diffMs = until - now;
                            const mins = Math.floor(diffMs / 60000);
                            const hrs = Math.floor(mins / 60);
                            const days = Math.floor(hrs / 24);
                            let remaining = '';
                            if (days >= 1) remaining = `${days} day${days>1?'s':''}`;
                            else if (hrs >= 1) remaining = `${hrs} hour${hrs>1?'s':''}`;
                            else if (mins >= 1) remaining = `${mins} minute${mins>1?'s':''}`;
                            else remaining = 'less than a minute';
                            errorMsg += ` — muted until ${until.toLocaleString()} (${remaining} remaining)`;
                        }
                    } else if (respJson && respJson.banned_until) {
                        const until = new Date(respJson.banned_until);
                        const now = new Date();
                        if (until > now) {
                            const diffMs = until - now;
                            const days = Math.floor(diffMs / 86400000);
                            let remaining = days >= 1 ? `${days} day${days>1?'s':''}` : 'less than a day';
                            errorMsg += ` — banned until ${until.toLocaleString()} (${remaining} remaining)`;
                        }
                    }
                } catch (e) { /* ignore formatting errors */ }

                window.showAlert && window.showAlert('error', errorMsg, 8000);
                return;
            }
            if (response.status === 400) {
                if (respJson && respJson.warnings != null) {
                    const warnings = Number(respJson.warnings) || 0;
                    window.showAlert && window.showAlert('warning', (respJson && respJson.error) ? (respJson.error + ' — Warning ' + warnings + ' of ' + (respJson.maxWarnings || CLIENT_MAX_WARNINGS)) : 'Message blocked.', 6000);
                    return;
                }
            }
            window.showAlert && window.showAlert('error', (respJson && respJson.error) ? respJson.error : 'Failed to send message', 5000);
            return;
        }

        input.value = '';
        currentReplyTo = null;
        hideReplyBanner();

        // Immediately reload messages
        await loadMessages();
    } catch (error) {
        console.error('Error sending message:', error);
        window.showAlert && window.showAlert('error', 'Failed to send message. Please try again.');
    }
}

// Online users list removed — sidebar handled in HTML; presence ping still runs via updateOnlineStatus

// Start a private chat with another user
async function startPrivateChat(userId, username) {
    // Ensure we know the current user before allowing private chat
    if (!currentUser) {
        try {
            const resp = await fetch('/api/auth/me', { credentials: 'include' });
            if (resp.ok) {
                const d = await resp.json();
                currentUser = d.user;
            }
        } catch (e) { /* ignore */ }
    }

    // Prevent starting a private chat with yourself
    if (currentUser && String(currentUser.id) === String(userId)) {
        alert('You cannot start a private chat with yourself.');
        return;
    }

    currentChatType = 'private';
    currentRecipientId = userId;
    currentRecipientName = username;

    // Update header text and show avatar
    const headerTitleText = document.getElementById('chatHeaderTitleText');
    const headerAvatar = document.getElementById('chatHeaderAvatar');
    if (headerTitleText) headerTitleText.textContent = `${username}`;
    if (headerAvatar) {
        headerAvatar.style.display = 'inline-block';
        headerAvatar.src = '/images/default-avatar.svg';
        headerAvatar.style.cursor = 'pointer';
        headerAvatar.title = `View ${username}`;
        headerAvatar.onclick = () => { window.location.href = '/user.html?user=' + encodeURIComponent(userId); };
        // Try to fetch the user's avatar URL (best-effort)
        (async () => {
            try {
                const r = await fetch(`/api/users/${encodeURIComponent(userId)}`);
                if (!r.ok) return;
                const d = await r.json();
                const url = d && d.user && d.user.profile_picture_url ? d.user.profile_picture_url : null;
                if (url) headerAvatar.src = url;
            } catch (e) { /* ignore */ }
        })();
    }

    const closeBtn = document.getElementById('closePrivateBtn');
    if (closeBtn) {
        closeBtn.style.display = 'inline-block';
        closeBtn.onclick = backToContactList;
    }

    // Load messages for private chat
    messages = [];
    document.getElementById('chatMessages').innerHTML = `
        <div style="text-align: center; padding: 40px 20px; color: var(--dark-gray);">
            <div class="spinner"></div>
            <p style="margin-top: 16px;">Loading messages...</p>
        </div>
    `;
    loadMessages();
    updateChatInputState();

    // mark private as seen when opening the conversation
    try { setLastSeen(LAST_SEEN_PRIVATE_KEY, new Date().toISOString()); pollUnreadCounts(); } catch (e) {}
}

function closePrivateChat() {
    currentChatType = 'general';
    currentRecipientId = null;
    currentRecipientName = null;

    const headerTitleText = document.getElementById('chatHeaderTitleText');
    const headerAvatar = document.getElementById('chatHeaderAvatar');
    if (headerTitleText) headerTitleText.textContent = 'General Chat';
    if (headerAvatar) {
        headerAvatar.style.display = 'none';
        headerAvatar.onclick = null;
        headerAvatar.title = '';
        headerAvatar.style.cursor = '';
    }

    const closeBtn = document.getElementById('closePrivateBtn');
    if (closeBtn) closeBtn.style.display = 'none';

    messages = [];
    document.getElementById('chatMessages').innerHTML = `
        <div style="text-align: center; padding: 40px 20px; color: var(--dark-gray);">
            <div class="spinner"></div>
            <p style="margin-top: 16px;">Loading messages...</p>
        </div>
    `;
    loadMessages();
    updateChatInputState();
}

function switchChat(type) {
    // Map UI tab types to internal chat types. 'personal' maps to private mode.
    if (type === 'personal') {
        currentChatType = 'private';
        // Clear any previously selected recipient so users must pick someone
        currentRecipientId = null;
        currentRecipientName = null;
        // Show contact list view instead of chat
        showContactList();
        return;
    } else {
        currentChatType = type;
        // Leaving recipient null when switching to general
        if (type === 'general') {
            currentRecipientId = null;
            currentRecipientName = null;
        }
    }

    // Hide contact list and show chat view
    const contactListView = document.getElementById('contactListView');
    const chatView = document.getElementById('chatView');
    if (contactListView) contactListView.style.display = 'none';
    if (chatView) chatView.style.display = 'block';

    // Update tabs
    document.querySelectorAll('.chat-tab').forEach(tab => {
        tab.classList.remove('active');
    });
    if (event && event.target) {
        const tabEl = event.target.closest('.chat-tab');
        if (tabEl) tabEl.classList.add('active');
    }

    // Update header
    const headerTitleText2 = document.getElementById('chatHeaderTitleText');
    const headerAvatar2 = document.getElementById('chatHeaderAvatar');
    const closePrivateBtn = document.getElementById('closePrivateBtn');
    if (headerTitleText2) headerTitleText2.textContent = currentChatType === 'general' ? 'General Chat' : 'Personal Chat';
    if (currentChatType === 'general' && headerAvatar2) {
        headerAvatar2.style.display = 'none';
        headerAvatar2.onclick = null;
        headerAvatar2.title = '';
        headerAvatar2.style.cursor = '';
    }
    if (closePrivateBtn) closePrivateBtn.style.display = 'none';

    // Load messages for the selected mode
    messages = [];
    const chatMessagesEl = document.getElementById('chatMessages');
    if (chatMessagesEl) chatMessagesEl.innerHTML = `
        <div style="text-align: center; padding: 40px 20px; color: var(--dark-gray);">
            <div class="spinner"></div>
            <p style="margin-top: 16px;">Loading messages...</p>
        </div>
    `;
    loadMessages();
    updateChatInputState();

    // If switching to general or personal, mark that tab as seen to clear badges
    try {
        const now = new Date().toISOString();
        if (currentChatType === 'general') {
            setLastSeen(LAST_SEEN_GENERAL_KEY, now);
        } else if (currentChatType === 'private') {
            setLastSeen(LAST_SEEN_PRIVATE_KEY, now);
        }
        pollUnreadCounts();
    } catch (e) { /* ignore */ }
}

// Contact list functions for personal chat
async function showContactList() {
    // Show contact list view, hide chat view
    const contactListView = document.getElementById('contactListView');
    const chatView = document.getElementById('chatView');
    if (contactListView) contactListView.style.display = 'block';
    if (chatView) chatView.style.display = 'none';

    // Update tabs
    document.querySelectorAll('.chat-tab').forEach(tab => {
        tab.classList.remove('active');
    });
    const personalTab = Array.from(document.querySelectorAll('.chat-tab')).find(tab => 
        tab.textContent.includes('Personal')
    );
    if (personalTab) personalTab.classList.add('active');

    // Load conversation list
    await loadContactList();

    // Mark personal tab as seen
    try {
        const now = new Date().toISOString();
        setLastSeen(LAST_SEEN_PRIVATE_KEY, now);
        pollUnreadCounts();
    } catch (e) { /* ignore */ }
}

async function loadContactList() {
    const contactList = document.getElementById('contactList');
    if (!contactList) return;

    try {
        // Fetch recent private messages to determine conversation partners
        const response = await fetch('/api/messages/private-inbox?limit=200', {
            credentials: 'include'
        });

        if (!response.ok) {
            throw new Error('Failed to fetch conversations');
        }

        const data = await response.json();
        const messages = data.messages || [];

        // Group messages by conversation partner
        const conversationMap = new Map();
        
        for (const msg of messages) {
            const partnerId = msg.user_id;
            if (!partnerId || !currentUser || String(partnerId) === String(currentUser.id)) continue;
            
            if (!conversationMap.has(partnerId)) {
                conversationMap.set(partnerId, {
                    userId: partnerId,
                    username: msg.username || (msg.users && msg.users.username) || 'User',
                    avatarUrl: (msg.users && msg.users.profile_picture_url) || '/images/default-avatar.svg',
                    lastMessage: msg.message,
                    lastMessageTime: msg.created_at
                });
            }
        }

        // Also fetch messages sent by current user to find more conversations
        const sentResponse = await fetch('/api/messages/general?limit=200', {
            credentials: 'include'
        });
        
        if (sentResponse.ok) {
            const sentData = await sentResponse.json();
            const sentMessages = (sentData.messages || []).filter(m => 
                m.chat_type === 'private' && 
                m.user_id && currentUser && 
                String(m.user_id) === String(currentUser.id)
            );

            for (const msg of sentMessages) {
                const partnerId = msg.recipient_id;
                if (!partnerId || String(partnerId) === String(currentUser.id)) continue;
                
                // Try to get username from message or fetch it
                const username = 'User';
                const avatarUrl = '/images/default-avatar.svg';
                
                if (!conversationMap.has(partnerId)) {
                    // Fetch user info
                    try {
                        const userResp = await fetch(`/api/users/${encodeURIComponent(partnerId)}`, {
                            credentials: 'include'
                        });
                        if (userResp.ok) {
                            const userData = await userResp.json();
                            const user = userData.user;
                            conversationMap.set(partnerId, {
                                userId: partnerId,
                                username: user.display_name || user.username || 'User',
                                avatarUrl: user.profile_picture_url || '/images/default-avatar.svg',
                                lastMessage: msg.message,
                                lastMessageTime: msg.created_at
                            });
                        }
                    } catch (e) {
                        conversationMap.set(partnerId, {
                            userId: partnerId,
                            username: username,
                            avatarUrl: avatarUrl,
                            lastMessage: msg.message,
                            lastMessageTime: msg.created_at
                        });
                    }
                } else {
                    // Update if this message is newer
                    const existing = conversationMap.get(partnerId);
                    if (new Date(msg.created_at) > new Date(existing.lastMessageTime)) {
                        existing.lastMessage = msg.message;
                        existing.lastMessageTime = msg.created_at;
                    }
                }
            }
        }

        // Convert to array and sort by most recent
        const conversations = Array.from(conversationMap.values())
            .sort((a, b) => new Date(b.lastMessageTime) - new Date(a.lastMessageTime));

        if (conversations.length === 0) {
            contactList.innerHTML = `
                <div class="contact-empty">
                    <i class="bi bi-chat-dots"></i>
                    <p>No conversations yet</p>
                    <p style="font-size: 0.875rem; margin-top: 8px;">Start chatting with other users to see your conversations here</p>
                </div>
            `;
            return;
        }

        // Render contact list
        contactList.innerHTML = conversations.map(contact => `
            <div class="contact-item" onclick="openConversation('${contact.userId}', '${escapeHtml(contact.username).replace(/'/g, '\\&#39;')}')">
                <img src="${contact.avatarUrl}" 
                     onerror="this.onerror=null;this.src='/images/default-avatar.svg'" 
                     alt="${escapeHtml(contact.username)}" 
                     class="contact-avatar">
                <div class="contact-info">
                    <div class="contact-name">${escapeHtml(contact.username)}</div>
                    <div class="contact-preview">${escapeHtml(contact.lastMessage).substring(0, 60)}${contact.lastMessage.length > 60 ? '...' : ''}</div>
                </div>
                <div class="contact-time">${formatTime(contact.lastMessageTime)}</div>
            </div>
        `).join('');

    } catch (error) {
        console.error('Error loading contact list:', error);
        contactList.innerHTML = `
            <div class="contact-empty">
                <i class="bi bi-exclamation-triangle"></i>
                <p>Failed to load conversations</p>
                <button onclick="loadContactList()" class="btn btn-primary" style="margin-top: 16px;">Retry</button>
            </div>
        `;
    }
}

function openConversation(userId, username) {
    // Hide contact list, show chat view
    const contactListView = document.getElementById('contactListView');
    const chatView = document.getElementById('chatView');
    if (contactListView) contactListView.style.display = 'none';
    if (chatView) chatView.style.display = 'block';

    // Start private chat with selected user
    startPrivateChat(userId, username);
}

function backToContactList() {
    // Clear current conversation
    currentRecipientId = null;
    currentRecipientName = null;
    currentChatType = 'private';
    
    // Show contact list
    showContactList();
}

async function updateOnlineStatus() {
    try {
        await fetch('/api/online-status', {
            method: 'POST',
            credentials: 'include'
        });
    } catch (error) {
        console.error('Error updating online status:', error);
    }
}

function formatTime(timestamp) {
    const date = new Date(timestamp);
    const now = new Date();
    const diff = now - date;
    const minutes = Math.floor(diff / 60000);
    const hours = Math.floor(diff / 3600000);
    const days = Math.floor(diff / 86400000);

    if (minutes < 1) return 'Just now';
    if (minutes < 60) return `${minutes}m ago`;
    if (hours < 24) return `${hours}h ago`;
    if (days < 7) return `${days}d ago`;
    
    return date.toLocaleDateString();
}

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

// Report modal for chat messages
window.openMessageReportModal = async function(messageId) {
    const existing = document.getElementById('messageReportModal');
    if (existing) existing.remove();

    // Load policies from API
    let policies = [];
    try {
        const response = await fetch('/api/policies');
        if (response.ok) {
            const allPolicies = await response.json();
            policies = allPolicies.filter(p => p.category === 'message' || p.category === 'both');
        }
    } catch (error) {
        console.error('Error loading policies:', error);
    }

    const modal = document.createElement('div');
    modal.id = 'messageReportModal';
    modal.className = 'modal';
    modal.style.display = 'flex';
    modal.style.zIndex = '7000';
    modal.innerHTML = `
        <div class="modal-content" style="max-width:600px;">
            <div class="modal-header">
                <h3 class="modal-title"><i class="bi bi-flag-fill"></i> Report Message</h3>
                <button class="modal-close" id="reportModalClose">&times;</button>
            </div>
            <div class="modal-body">
                <p style="margin-bottom:16px;color:#666;">Select the policy violation that best describes this message:</p>
                <div class="form-group">
                    <label>Policy Violation <span style="color:red;">*</span></label>
                    <select id="reportPolicySelect" class="form-control" required>
                        <option value="">Select a policy violation...</option>
                        ${policies.map(p => 
                            `<option value="${p.id}" title="${p.description}">${p.title}</option>`
                        ).join('')}
                    </select>
                    <small style="color:#666;display:block;margin-top:6px;">This helps our moderation team respond appropriately</small>
                </div>
                <div style="margin-top:16px;">
                    <label for="reportDetails">Additional Details (Optional)</label>
                    <textarea id="reportDetails" class="form-control" placeholder="Provide any additional context to help moderators..." style="width:100%;height:90px;resize:vertical;"></textarea>
                </div>
            </div>
            <div class="modal-footer">
                <button class="btn btn-light" id="reportCancel">Cancel</button>
                <button class="btn btn-danger" id="reportSubmit"><i class="bi bi-send-fill"></i> Submit Report</button>
            </div>
        </div>
    `;
    document.body.appendChild(modal);

    const close = () => { try { modal.remove(); } catch(e) {} };
    document.getElementById('reportModalClose').onclick = close;
    document.getElementById('reportCancel').onclick = close;
    
    document.getElementById('reportSubmit').onclick = async () => {
        const policyId = document.getElementById('reportPolicySelect').value;
        const details = document.getElementById('reportDetails').value.trim();
        
        // Validate policy selection
        if (!policyId) {
            await window.showModal('Please select a policy violation', 'Error');
            return;
        }
        
        // Get selected policy title
        const selectedPolicy = policies.find(p => p.id.toString() === policyId);
        const reportType = selectedPolicy ? selectedPolicy.title : 'Policy Violation';
        
        const btn = document.getElementById('reportSubmit');
        btn.disabled = true;
        
        try {
            const resp = await fetch(`/api/messages/${encodeURIComponent(messageId)}/report`, {
                method: 'POST',
                credentials: 'include',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ report_type: reportType, details })
            });

            if (!resp.ok) {
                const j = await resp.json().catch(() => null);
                await window.showModal((j && j.error) ? j.error : 'Failed to submit report', 'Error');
                return;
            }

            await window.showModal('Report submitted successfully. Our moderation team will review it.', 'Success');
            close();
        } catch (e) {
            console.error('Report submission error:', e);
            await window.showModal('Failed to submit report', 'Error');
        } finally {
            btn.disabled = false;
        }
    };
};

function toggleSidebar() {
    document.getElementById('sidebar').classList.toggle('show');
}

function showReplyBanner(username, message) {
    const banner = document.getElementById('replyBanner');
    const usernameEl = document.getElementById('replyUsername');
    const messageEl = document.getElementById('replyMessage');
    
    if (banner && usernameEl && messageEl) {
        usernameEl.textContent = username;
        messageEl.textContent = message;
        banner.style.display = 'block';
    }
}

function hideReplyBanner() {
    const banner = document.getElementById('replyBanner');
    if (banner) banner.style.display = 'none';
}

function cancelReply() {
    currentReplyTo = null;
    hideReplyBanner();
}

async function logout() {
    try {
        const ok = await window.showConfirm('Are you sure you want to logout?', 'Confirm');
        if (!ok) return;

        const resp = await fetch('/api/auth/logout', {
            method: 'POST',
            credentials: 'include'
        });

        if (!resp.ok) {
            console.error('Logout failed:', resp.statusText || resp.status);
            await window.showModal('Failed to log out. Please try again.', 'Error', { small: true });
            return;
        }

        window.location.href = '/login';
    } catch (error) {
        console.error('Logout error:', error);
        try { await window.showModal('An error occurred while logging out. Redirecting to login.', 'Error', { small: true }); } catch (e) {}
        window.location.href = '/login';
    }
}
