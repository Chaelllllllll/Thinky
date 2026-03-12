/**
 * Chat JavaScript — Sidebar Layout Edition
 * Handles chat functionality with a persistent people sidebar.
 */

// ─── State ──────────────────────────────────────────────────────────────────
let currentChatType = 'general';
let currentUser = null;
let messages = [];
let currentRecipientId = null;
let currentReplyTo = null;
let currentRecipientName = null;
let _sendingMessage = false;
let oldestMessageId = null;
let isLoadingMore = false;
let hasMoreMessages = true;
let isAnonMode = false;

// Sidebar state
let _sidebarContacts = [];        // merged list: conversations + followers/following
let _sidebarUnreadPerUser = {};   // { userId: count }
let _sidebarLoaded = false;

// Client-side blacklist (mirrors server — server is authoritative; client is UX-only)
const CLIENT_BLACKLIST = ['badword1','badword2','slur'];
const CLIENT_MAX_WARNINGS = 3;
const MESSAGE_REACTION_TYPES = ['like', 'love', 'haha', 'sad', 'wow', 'angry'];
const MESSAGE_REACTION_EMOJIS = {
    like: '👍',
    love: '❤️',
    haha: '😂',
    sad: '😢',
    wow: '😮',
    angry: '😡'
};

// Fallback anonymous detection (matches server-side generator)
function generateAnonymousName(userId) {
    const adjectives = [
        'Mystic','Shadow','Silent','Bright','Swift','Calm','Bold','Gentle','Wild','Noble',
        'Cosmic','Azure','Crimson','Golden','Jade','Luna','Solar','Stellar','Vivid','Zen',
        'Amber','Cobalt','Dusk','Ember','Frost','Ivory','Navy','Onyx','Pearl','Ruby'
    ];
    const animals = [
        'Fox','Wolf','Hawk','Bear','Deer','Lion','Owl','Raven','Seal','Tiger',
        'Crane','Drake','Eagle','Finch','Goose','Heron','Ibis','Jaguar','Koala','Lynx',
        'Mink','Newt','Orca','Panda','Quail','Robin','Stoat','Toad','Vole','Wren'
    ];
    const str = String(userId || '');
    let h1 = 0, h2 = 0, h3 = 0;
    for (let i = 0; i < str.length; i++) {
        const c = str.charCodeAt(i);
        h1 = Math.imul(h1, 31) + c | 0;
        h2 = Math.imul(h2, 37) + c | 0;
        h3 = Math.imul(h3, 41) + c | 0;
    }
    const adj    = adjectives[Math.abs(h1) % adjectives.length];
    const animal = animals[Math.abs(h2) % animals.length];
    const num    = Math.abs(h3) % 900 + 100;
    return `${adj}${animal}#${num}`;
}

function isAnonymousGeneralMessage(msg) {
    if (!msg) return false;
    const rawFlag = msg.is_anonymous;
    if (rawFlag === true || rawFlag === 1 || rawFlag === '1' || rawFlag === 'true' || rawFlag === 't') return true;
    const uid = msg.user_id;
    const uname = String(msg.username || '');
    if (!uid || !uname) return false;
    return uname === generateAnonymousName(uid);
}

function clientNormalizeForMatch(text) {
    if (!text) return '';
    let s = String(text).normalize('NFKD').replace(/\p{Diacritic}/gu, '');
    s = s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    return s;
}

function clientHasBlacklistedWord(text) {
    const norm = clientNormalizeForMatch(text);
    for (const raw of CLIENT_BLACKLIST) {
        if (!raw) continue;
        const esc = raw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        if (new RegExp('\\b' + esc + '\\b', 'i').test(norm)) return true;
    }
    return false;
}

// WebSocket client for real-time chat updates
async function initChatWebSocket() {
    try {
        // Reuse existing connection if present
        if (window._chatSocket && window._chatSocket.readyState === 1) return true;

        const resp = await fetch('/api/ws/chat-token', { method: 'POST', credentials: 'include' });
        if (!resp.ok) return false;
        const data = await resp.json();
        const token = data && data.token;
        if (!token) return false;

        const proto = (location.protocol === 'https:') ? 'wss' : 'ws';
        const url = `${proto}://${location.host}/ws/chat?token=${encodeURIComponent(token)}`;

        return await new Promise((resolve) => {
            try {
                const ws = new WebSocket(url);
                window._chatSocket = ws;

                const timeout = setTimeout(() => {
                    try { ws.close(); } catch (_) {}
                    resolve(false);
                }, 5000);

                ws.addEventListener('open', () => {
                    clearTimeout(timeout);
                    window._chatSocketConnected = true;
                    ws.addEventListener('message', handleChatSocketMessage);
                    ws.addEventListener('close', () => { window._chatSocketConnected = false; window._chatSocket = null; });
                    resolve(true);
                });

                ws.addEventListener('error', () => { clearTimeout(timeout); resolve(false); });
            } catch (e) { resolve(false); }
        });
    } catch (e) {
        return false;
    }
}

async function handleChatSocketMessage(ev) {
    try {
        const payload = JSON.parse(typeof ev.data === 'string' ? ev.data : ev.data.toString());
        if (!payload || !payload.type) return;
        if (payload.type === 'new_message') {
            const m = payload.message;
            if (!m || !m.id) return;

            // GENERAL chat message
            if (String(m.chat_type) === 'general') {
                // If viewing general chat, append and render
                if (currentChatType === 'general') {
                    const exists = messages.find(x => String(x.id) === String(m.id));
                    if (!exists) {
                        messages = [...messages, m];
                        await hydrateMessageReactions([m]);
                        displayMessages(true);
                    }
                } else {
                    // Not viewing general: update unread indicators
                    try { pollUnreadCounts(); } catch (_) {}
                }
                return;
            }

            // PRIVATE chat message
            if (String(m.chat_type) === 'private') {
                // If we're in the matching private conversation, append
                if (currentChatType === 'private' && currentRecipientId) {
                    const isForThisConversation = (
                        (String(m.user_id) === String(currentRecipientId) && String(m.recipient_id) === String(currentUser && currentUser.id)) ||
                        (String(m.user_id) === String(currentUser && currentUser.id) && String(m.recipient_id) === String(currentRecipientId))
                    );
                    if (isForThisConversation) {
                        const exists = messages.find(x => String(x.id) === String(m.id));
                        if (!exists) {
                            messages = [...messages, m];
                            await hydrateMessageReactions([m]);
                            displayMessages(true);
                        }
                    }
                }

                // Update per-user unread dots and badges
                try { pollSidebarUnreadDots(); pollUnreadCounts(); } catch (_) {}
                return;
            }
        }
    } catch (e) {
        // ignore malformed WS messages
    }
}

// ─── LocalStorage helpers ────────────────────────────────────────────────────
const LAST_SEEN_GENERAL_KEY = 'chat_last_seen_general';
const LAST_SEEN_PRIVATE_KEY = 'chat_last_seen_private';

function getLastSeen(key) {
    return localStorage.getItem(key) || new Date().toISOString();
}

function setLastSeen(key, iso) {
    try { localStorage.setItem(key, iso); } catch (e) { /* ignore */ }
}

// ─── Init ────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
    await loadCurrentUser();

    // Handle URL params: ?with=userId navigates directly to a private chat
    try {
        const params = new URLSearchParams(window.location.search);
        const scrollTo = params.get('scrollTo') || null;
        if (scrollTo) window._pendingScrollMessageId = String(scrollTo);

        const withId = params.get('with') || params.get('withUser') || params.get('user');
        if (withId) {
            // Pre-load the sidebar contacts (needed for active-state highlighting later)
            loadSidebarContacts(); // fire-and-forget; selectPrivate will set header immediately
            // Fetch user info for the header
            try {
                const r = await fetch(`/api/users/${encodeURIComponent(withId)}`, { credentials: 'include' });
                const d = r.ok ? await r.json() : null;
                const u = d && d.user;
                const name = (u && (u.display_name || u.username)) || 'User';
                const avatar = (u && u.profile_picture_url) || '/images/default-avatar.svg';
                selectPrivate(withId, name, avatar);
            } catch (_) {
                selectPrivate(withId, 'User', '/images/default-avatar.svg');
            }
        } else {
            // Default: open general chat and load sidebar
            selectGeneral();
            loadSidebarContacts();
        }
    } catch (e) {
        selectGeneral();
        loadSidebarContacts();
    }

    // Try real-time WebSocket first, otherwise fallback to adaptive polling
    (async function startRealtimeOrPolling() {
        try { window._chatPollingActive = true; } catch (e) {}
        const connected = await initChatWebSocket();
        if (connected) return; // WebSocket will drive updates

        // Fallback: adaptive polling
        let lastMsgCount = 0;
        let pollInterval = 3000;

        async function poll() {
            await loadMessages(true);
            const n = messages.length;
            if (n !== lastMsgCount) {
                pollInterval = Math.max(2000, pollInterval - 500);
                lastMsgCount = n;
            } else {
                pollInterval = Math.min(10000, pollInterval + 1000);
            }
            setTimeout(poll, pollInterval);
        }
        poll();
    })();

    // Sidebar contact list refresh every 30s (pick up new conversations)
    setInterval(() => { loadSidebarContacts(true); }, 30000);

    // Unread polling: general badge + per-user dots
    startUnreadPolling();

    // Lazy-load older messages on scroll to top
    const chatMessagesEl = document.getElementById('chatMessages');
    if (chatMessagesEl) {
        chatMessagesEl.addEventListener('scroll', async () => {
            if (isLoadingMore || !hasMoreMessages) return;
            if (chatMessagesEl.scrollTop < 100) {
                isLoadingMore = true;
                const before = chatMessagesEl.scrollHeight;
                const top = chatMessagesEl.scrollTop;
                await loadOlderMessages();
                requestAnimationFrame(() => {
                    chatMessagesEl.scrollTop = top + (chatMessagesEl.scrollHeight - before);
                });
                isLoadingMore = false;
            }
        });
    }
});

// ─── Auth ────────────────────────────────────────────────────────────────────
async function loadCurrentUser() {
    try {
        const resp = await fetch('/api/auth/me', { credentials: 'include' });
        if (!resp.ok) { window.location.href = '/login'; return; }
        const data = await resp.json();
        currentUser = data.user;
    } catch (e) {
        window.location.href = '/login';
    }
}

// ─── Sidebar: selectGeneral / selectPrivate ──────────────────────────────────
function selectGeneral() {
    currentChatType = 'general';
    currentRecipientId = null;
    currentRecipientName = null;
    currentReplyTo = null;
    hideReplyBanner();

    // Update header
    const titleEl = document.getElementById('chatHeaderTitleText');
    const avatarEl = document.getElementById('chatHeaderAvatar');
    const closeBtn = document.getElementById('closePrivateBtn');
    const deleteBtn = document.getElementById('deleteConversationBtn');
    if (titleEl) titleEl.textContent = 'General Chat';
    if (avatarEl) { avatarEl.style.display = 'none'; avatarEl.onclick = null; }
    if (closeBtn) closeBtn.style.display = 'none';
    if (deleteBtn) deleteBtn.style.display = 'none';

    // Sidebar highlight
    const generalItem = document.getElementById('generalChatItem');
    if (generalItem) {
        document.querySelectorAll('.cps-contact.active').forEach(el => el.classList.remove('active'));
        generalItem.classList.add('active');
    }

    // On mobile: hide people sidebar, show chat main
    hidePeopleSidebarMobile();

    // Clear unread badge on general
    setLastSeen(LAST_SEEN_GENERAL_KEY, new Date().toISOString());
    const badge = document.getElementById('generalSidebarBadge');
    if (badge) badge.style.display = 'none';
    pollUnreadCounts();

    messages = [];
    showChatLoadingState();
    loadMessages();
    updateChatInputState();

    // Show anon toggle (general chat only)
    const anonBtn = document.getElementById('anonToggleBtn');
    if (anonBtn) anonBtn.style.display = 'flex';
}

async function selectPrivate(userId, username, avatarUrl) {
    if (!currentUser) {
        try {
            const r = await fetch('/api/auth/me', { credentials: 'include' });
            if (r.ok) { const d = await r.json(); currentUser = d.user; }
        } catch (_) {}
    }

    if (currentUser && String(currentUser.id) === String(userId)) {
        window.showAlert && window.showAlert('error', 'You cannot chat with yourself.');
        return;
    }

    currentChatType = 'private';
    currentRecipientId = userId;
    currentRecipientName = username;
    currentReplyTo = null;
    hideReplyBanner();

    // Update header
    const titleEl = document.getElementById('chatHeaderTitleText');
    const avatarEl = document.getElementById('chatHeaderAvatar');
    const closeBtn = document.getElementById('closePrivateBtn');
    const deleteBtn = document.getElementById('deleteConversationBtn');

    if (titleEl) titleEl.textContent = username;
    if (avatarEl) {
        avatarEl.src = avatarUrl || '/images/default-avatar.svg';
        avatarEl.style.display = 'inline-block';
        avatarEl.onclick = () => { window.location.href = '/user.html?user=' + encodeURIComponent(userId); };
        avatarEl.title = `View ${username}`;
        // Best-effort avatar fetch if not already provided
        if (!avatarUrl) {
            fetch(`/api/users/${encodeURIComponent(userId)}`, { credentials: 'include' })
                .then(r => r.ok ? r.json() : null)
                .then(d => { if (d && d.user && d.user.profile_picture_url) avatarEl.src = d.user.profile_picture_url; })
                .catch(() => {});
        }
    }
    if (closeBtn) {
        closeBtn.style.display = 'inline-flex';
        closeBtn.onclick = () => { selectGeneral(); showPeopleSidebarMobile(); };
    }
    if (deleteBtn) deleteBtn.style.display = 'inline-flex';

    // Sidebar highlight
    document.getElementById('generalChatItem')?.classList.remove('active');
    document.querySelectorAll('.cps-contact.active').forEach(el => el.classList.remove('active'));
    const contactEl = document.getElementById('cps-contact-' + userId);
    if (contactEl) contactEl.classList.add('active');

    // Clear per-user unread dot
    _sidebarUnreadPerUser[userId] = 0;
    const dot = document.getElementById('cps-dot-' + userId);
    if (dot) dot.style.display = 'none';

    // On mobile: hide people sidebar, show chat main
    hidePeopleSidebarMobile();

    // Mark private as seen
    setLastSeen(LAST_SEEN_PRIVATE_KEY, new Date().toISOString());
    pollUnreadCounts();

    messages = [];
    showChatLoadingState();
    loadMessages();
    updateChatInputState();

    // Hide anon toggle and reset anonymous mode for private chats
    isAnonMode = false;
    const anonBtn = document.getElementById('anonToggleBtn');
    const anonBanner = document.getElementById('anonBanner');
    if (anonBtn) { anonBtn.style.display = 'none'; anonBtn.classList.remove('active'); }
    if (anonBanner) anonBanner.style.display = 'none';
}

function showChatLoadingState() {
    const el = document.getElementById('chatMessages');
    if (el) el.innerHTML = `
        <div style="text-align:center;padding:60px 20px;color:var(--dark-gray);">
            <div class="spinner"></div>
            <p style="margin-top:16px;">Loading messages...</p>
        </div>`;
}

// ─── Mobile sidebar helpers ──────────────────────────────────────────────────
function hidePeopleSidebarMobile() {
    if (window.innerWidth <= 768) {
        const sidebar = document.getElementById('chatPeopleSidebar');
        if (sidebar) sidebar.classList.add('hidden-mobile');
        const backBtn = document.getElementById('chatBackBtn');
        if (backBtn) backBtn.style.display = 'flex';
    }
}

function showPeopleSidebarMobile() {
    if (window.innerWidth <= 768) {
        const sidebar = document.getElementById('chatPeopleSidebar');
        if (sidebar) sidebar.classList.remove('hidden-mobile');
        const backBtn = document.getElementById('chatBackBtn');
        if (backBtn) backBtn.style.display = 'none';
    }
}

function showSidebar() {
    showPeopleSidebarMobile();
}

// ─── Sidebar: contact loading ────────────────────────────────────────────────
async function loadSidebarContacts(silent = false) {
    const listEl = document.getElementById('chatContactsList');

    if (!silent && listEl) {
        listEl.innerHTML = `<div class="cps-empty"><i class="bi bi-hourglass-split"></i><p>Loading contacts...</p></div>`;
    }

    try {
        // Fetch conversations (private inbox — messages I received)
        const [inboxResp, socialResp] = await Promise.all([
            fetch('/api/messages/private-inbox?limit=200', { credentials: 'include' }),
            fetch('/api/users/me/social', { credentials: 'include' })
        ]);

        const conversationMap = new Map();

        // Process inbox messages
        if (inboxResp.ok) {
            const { messages: inbox } = await inboxResp.json();
            for (const msg of (inbox || [])) {
                const partnerId = msg.user_id;
                if (!partnerId || (currentUser && String(partnerId) === String(currentUser.id))) continue;
                if (!conversationMap.has(partnerId)) {
                    conversationMap.set(partnerId, {
                        userId: partnerId,
                        username: msg.username || (msg.users && msg.users.username) || 'User',
                        displayName: (msg.users && msg.users.display_name) || msg.username || 'User',
                        avatarUrl: (msg.users && msg.users.profile_picture_url) || '/images/default-avatar.svg',
                        lastMessage: msg.message,
                        lastMessageTime: msg.created_at,
                        source: 'conversation'
                    });
                } else {
                    const ex = conversationMap.get(partnerId);
                    if (new Date(msg.created_at) > new Date(ex.lastMessageTime)) {
                        ex.lastMessage = msg.message;
                        ex.lastMessageTime = msg.created_at;
                    }
                }
            }
        }

        // Process social connections (followers + following)
        if (socialResp.ok) {
            const { people } = await socialResp.json();
            for (const person of (people || [])) {
                if (!person.id || (currentUser && String(person.id) === String(currentUser.id))) continue;
                if (!conversationMap.has(person.id)) {
                    conversationMap.set(person.id, {
                        userId: person.id,
                        username: person.username || 'User',
                        displayName: person.display_name || person.username || 'User',
                        avatarUrl: person.profile_picture_url || '/images/default-avatar.svg',
                        lastMessage: null,
                        lastMessageTime: null,
                        source: person.relation // 'follower' | 'following' | 'mutual'
                    });
                } else {
                    // Already in conversations — add relation tag
                    conversationMap.get(person.id).source = 'conversation+' + person.relation;
                }
            }
        }

        // Sort: conversations with recent messages first, then followers/following alphabetically
        const contacts = Array.from(conversationMap.values()).sort((a, b) => {
            if (a.lastMessageTime && b.lastMessageTime) return new Date(b.lastMessageTime) - new Date(a.lastMessageTime);
            if (a.lastMessageTime) return -1;
            if (b.lastMessageTime) return 1;
            return (a.displayName || a.username).localeCompare(b.displayName || b.username);
        });

        _sidebarContacts = contacts;
        _sidebarLoaded = true;
        renderSidebarContacts(contacts);

    } catch (err) {
        console.error('Error loading sidebar contacts:', err);
        if (listEl) listEl.innerHTML = `
            <div class="cps-empty">
                <i class="bi bi-exclamation-triangle"></i>
                <p>Failed to load contacts</p>
                <button onclick="loadSidebarContacts()" class="btn btn-primary" style="margin-top:12px;font-size:0.85rem;">Retry</button>
            </div>`;
    }
}

function renderSidebarContacts(contacts) {
    const listEl = document.getElementById('chatContactsList');
    if (!listEl) return;

    if (!contacts || contacts.length === 0) {
        listEl.innerHTML = `
            <div class="cps-empty">
                <i class="bi bi-people"></i>
                <p>No contacts yet</p>
                <p style="font-size:0.8rem;opacity:0.7;margin-top:6px;">Follow people or start chatting to see them here</p>
            </div>`;
        return;
    }

    listEl.innerHTML = contacts.map(c => {
        const name = escapeHtml(c.displayName || c.username);
        const preview = c.lastMessage ? escapeHtml(c.lastMessage).substring(0, 55) + (c.lastMessage.length > 55 ? '…' : '') : getRelationLabel(c.source);
        const time = c.lastMessageTime ? formatTime(c.lastMessageTime) : '';
        const isActive = currentChatType === 'private' && String(c.userId) === String(currentRecipientId);
        const unread = _sidebarUnreadPerUser[c.userId] || 0;
        const avatarSafe = escapeHtml(c.avatarUrl || '/images/default-avatar.svg');
        const nameSafe = escapeHtml(c.displayName || c.username).replace(/'/g, '&#39;');

        return `
        <div class="cps-contact${isActive ? ' active' : ''}" id="cps-contact-${c.userId}"
             onclick="selectPrivate('${c.userId}', '${nameSafe}', '${avatarSafe.replace(/'/g, '&#39;')}')">
            <img src="${avatarSafe}" alt="${name}" class="cps-contact-avatar"
                 onerror="this.onerror=null;this.src='/images/default-avatar.svg'">
            <div class="cps-contact-info">
                <div class="cps-contact-name">${name}</div>
                <div class="cps-contact-preview">${preview}</div>
            </div>
            <div class="cps-contact-meta">
                ${time ? `<div class="cps-contact-time">${time}</div>` : ''}
                <div class="cps-unread-dot" id="cps-dot-${c.userId}" style="${unread > 0 ? '' : 'display:none;'}">${unread > 99 ? '99+' : unread}</div>
            </div>
        </div>`;
    }).join('');
}

function getRelationLabel(source) {
    if (!source) return '';
    if (source.includes('mutual')) return '↔ Mutual follower';
    if (source.includes('follower')) return '↓ Follows you';
    if (source.includes('following')) return '↑ You follow';
    return '';
}

function filterSidebarContacts(query) {
    if (!query || !query.trim()) {
        renderSidebarContacts(_sidebarContacts);
        return;
    }
    const q = query.toLowerCase().trim();
    const filtered = _sidebarContacts.filter(c =>
        (c.username && c.username.toLowerCase().includes(q)) ||
        (c.displayName && c.displayName.toLowerCase().includes(q))
    );
    renderSidebarContacts(filtered);
}

// ─── Unread badges ───────────────────────────────────────────────────────────
let unreadPollInterval = null;

function updateUnreadBadges(counts) {
    const g = counts && counts.general ? parseInt(counts.general, 10) : 0;
    const p = counts && counts.private ? parseInt(counts.private, 10) : 0;
    const total = g + p;

    // General sidebar badge (in the people sidebar)
    const genBadge = document.getElementById('generalSidebarBadge');
    if (genBadge) {
        if (g > 0 && currentChatType !== 'general') {
            genBadge.style.display = 'inline-block';
            genBadge.textContent = g > 99 ? '99+' : String(g);
        } else {
            genBadge.style.display = 'none';
        }
    }

    // App sidebar chat badge
    const appBadge = document.getElementById('sidebarChatBadge');
    if (appBadge) {
        if (total > 0) { appBadge.style.display = 'inline-block'; appBadge.textContent = total > 99 ? '99+' : String(total); }
        else { appBadge.style.display = 'none'; }
    }

    // Trigger browser notification if there are new private messages
    if (p > 0 && typeof window.showChatNotification === 'function') {
        // showChatNotification is defined in unreadNotifications.js or similar
        // only show when window is not focused
        if (document.hidden) window.showChatNotification('private', p);
    }
}

async function pollUnreadCounts() {
    if (!currentUser) return;
    try {
        const lg = encodeURIComponent(getLastSeen(LAST_SEEN_GENERAL_KEY));
        const lp = encodeURIComponent(getLastSeen(LAST_SEEN_PRIVATE_KEY));
        const resp = await fetch(`/api/messages/unread?lastSeenGeneral=${lg}&lastSeenPrivate=${lp}`, { credentials: 'include' });
        if (!resp.ok) return;
        const data = await resp.json();
        updateUnreadBadges(data);
    } catch (_) {}
}

async function pollSidebarUnreadDots() {
    if (!currentUser) return;
    try {
        const lp = encodeURIComponent(getLastSeen(LAST_SEEN_PRIVATE_KEY));
        const resp = await fetch(`/api/messages/unread-per-user?lastSeenPrivate=${lp}`, { credentials: 'include' });
        if (!resp.ok) return;
        const { counts } = await resp.json();
        _sidebarUnreadPerUser = counts || {};

        // Update dots in sidebar
        for (const [uid, count] of Object.entries(_sidebarUnreadPerUser)) {
            // Don't show dot for the currently open conversation
            if (currentChatType === 'private' && String(uid) === String(currentRecipientId)) continue;
            const dot = document.getElementById('cps-dot-' + uid);
            if (dot) {
                if (count > 0) { dot.style.display = 'flex'; dot.textContent = count > 99 ? '99+' : String(count); }
                else { dot.style.display = 'none'; }
            }
        }
    } catch (_) {}
}

function startUnreadPolling() {
    if (unreadPollInterval) clearInterval(unreadPollInterval);
    setLastSeen(LAST_SEEN_GENERAL_KEY, getLastSeen(LAST_SEEN_GENERAL_KEY));
    setLastSeen(LAST_SEEN_PRIVATE_KEY, getLastSeen(LAST_SEEN_PRIVATE_KEY));
    pollUnreadCounts();
    pollSidebarUnreadDots();
    unreadPollInterval = setInterval(() => {
        pollUnreadCounts();
        pollSidebarUnreadDots();
    }, 5000);
}

// ─── Chat input state ────────────────────────────────────────────────────────
function updateChatInputState() {
    const input = document.getElementById('messageInput');
    const sendBtn = document.getElementById('sendBtn');
    if (!input || !sendBtn) return;

    if (currentChatType !== 'private') {
        input.disabled = false;
        sendBtn.disabled = false;
        input.placeholder = isAnonMode ? 'Sending as anonymous...' : 'Type a message to everyone...';
        return;
    }

    if (!currentRecipientId) {
        input.disabled = true;
        sendBtn.disabled = true;
        input.placeholder = 'Select a contact to start chatting...';
        return;
    }

    input.disabled = false;
    sendBtn.disabled = false;
    input.placeholder = `Message ${currentRecipientName || 'User'}...`;
}

// ─── Load messages ────────────────────────────────────────────────────────────
async function loadMessages(silent = false) {
    try {
        // During polling (silent=true with existing messages) only fetch NEW messages
        // using ?since= so we can append them without wiping lazy-loaded history.
        const isPolling = silent && messages.length > 0;
        const lastMsg = isPolling ? messages[messages.length - 1] : null;

        const params = new URLSearchParams();
        params.set('limit', '30');
        if (currentChatType === 'private') {
            if (!currentRecipientId) return;
            params.set('with', currentRecipientId);
        }
        if (isPolling && lastMsg) {
            params.set('since', lastMsg.created_at);
        }

        const url = `/api/messages/${currentChatType}?${params.toString()}`;
        const response = await fetch(url, { credentials: 'include' });
        if (!response.ok) {
            if (response.status === 401) { window.location.href = '/login'; return; }
            return;
        }

        const data = await response.json();
        const newMessages = data.messages || [];

        if (isPolling) {
            // Append only messages not already in the list
            if (newMessages.length === 0) return;
            const existingIds = new Set(messages.map(m => m.id));
            const fresh = newMessages.filter(m => !existingIds.has(m.id));
            if (fresh.length === 0) return;
            messages = [...messages, ...fresh];
            await hydrateMessageReactions(messages);
            displayMessages(true);
        } else {
            // Initial full load for this chat
            messages = newMessages;
            if (messages.length > 0) oldestMessageId = messages[0].id;
            hasMoreMessages = messages.length >= 30;
            await hydrateMessageReactions(messages);
            displayMessages(false);
        }
    } catch (err) {
        if (!silent) console.error('loadMessages error:', err);
    }
}

async function hydrateMessageReactions(messageList) {
    try {
        const list = Array.isArray(messageList) ? messageList : [];
        const ids = [...new Set(list.map(m => m && m.id).filter(Boolean).map(String))];
        if (ids.length === 0) return;

        const resp = await fetch(`/api/messages/reactions?ids=${encodeURIComponent(ids.join(','))}`, {
            credentials: 'include'
        });
        if (!resp.ok) return;

        const data = await resp.json();
        const reactionsByMessage = data.reactionsByMessage || {};
        const userReactions = data.userReactions || {};

        for (const msg of list) {
            if (!msg || !msg.id) continue;
            const key = String(msg.id);
            msg._reactions = reactionsByMessage[key] || {};
            msg._myReaction = userReactions[key] || null;
        }
    } catch (err) {
        console.warn('hydrateMessageReactions failed:', err && err.message ? err.message : err);
    }
}

function buildMessageReactionMarkup(msg) {
    const msgId = msg && msg.id ? String(msg.id) : '';
    if (!msgId) return '';

    const reactions = msg._reactions || {};
    const myReaction = msg._myReaction || null;

    const chips = MESSAGE_REACTION_TYPES
        .filter(type => Number(reactions[type] || 0) > 0)
        .map(type => {
            const count = Number(reactions[type] || 0);
            return `<button class="msg-reaction-chip${myReaction === type ? ' mine' : ''}" data-reaction="${type}" data-message-id="${escapeHtml(msgId)}">${MESSAGE_REACTION_EMOJIS[type]} ${count}</button>`;
        }).join('');

    return `
        <div class="msg-reactions-row">
            ${chips}
        </div>`;
}

async function reactToMessage(messageId, reactionType) {
    try {
        const resp = await fetch(`/api/messages/${encodeURIComponent(messageId)}/reactions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            body: JSON.stringify({ reaction: reactionType })
        });

        let payload = null;
        try { payload = await resp.json(); } catch (_) { payload = null; }

        if (!resp.ok) {
            const msg = payload && payload.error ? payload.error : 'Failed to react to message';
            window.showAlert && window.showAlert('error', msg, 4000);
            return;
        }

        await hydrateMessageReactions(messages);
        displayMessages(true);
    } catch (err) {
        console.error('reactToMessage error:', err);
        window.showAlert && window.showAlert('error', 'Failed to react to message', 3000);
    }
}

// ─── Display messages ─────────────────────────────────────────────────────────
function displayMessages(preserveScroll = false) {
    const container = document.getElementById('chatMessages');
    if (!container) return;

    const wasScrolledToBottom = !preserveScroll ||
        (container.scrollHeight - container.scrollTop - container.clientHeight < 80);

    if (messages.length === 0) {
        container.innerHTML = `
            <div class="chat-welcome">
                <i class="bi bi-chat-dots"></i>
                <h3>${currentChatType === 'general' ? 'General Chat' : 'Private Chat'}</h3>
                <p>${currentChatType === 'general' ? 'Be the first to say something!' : `Start a conversation with ${escapeHtml(currentRecipientName || 'this user')}.`}</p>
            </div>`;
        return;
    }

    container.innerHTML = messages.map(msg => {
        const isSelf = currentUser && String(msg.user_id) === String(currentUser.id);
        const isAnonMsg = isAnonymousGeneralMessage(msg);
        // For anonymous messages, use a generic incognito/ghost avatar
        const avatarUrl = isAnonMsg ? '/images/default-avatar.svg' : ((msg.users && msg.users.profile_picture_url) ? msg.users.profile_picture_url : '/images/default-avatar.svg');
        const safeUsername = escapeHtml(msg.username || 'User');
        const safeMessage = escapeHtml(msg.message || '');
        const time = formatTime(msg.created_at);
        const msgId = msg.id ? String(msg.id).replace(/[^a-zA-Z0-9_-]/g, '_') : '';

        // Reply preview block
        let replyBlock = '';
        if (msg.reply_to_meta) {
            const rt = msg.reply_to_meta;
            const rtSafe = escapeHtml(rt.message || '');
            const rtUser = escapeHtml(rt.username || 'User');
            const rtId = rt.id ? String(rt.id).replace(/[^a-zA-Z0-9_-]/g, '_') : '';
            replyBlock = `
                <div class="msg-reply-preview inline" data-target="msg-${rtId}">
                    <span class="reply-indicator"><i class="bi bi-reply-fill"></i></span>
                    <span style="font-size:0.82em;opacity:0.85;">${rtUser}:</span> ${rtSafe.substring(0, 80)}${rtSafe.length > 80 ? '…' : ''}
                </div>`;
        }

        return `
        <div class="chat-message${isSelf ? ' msg-self' : ''}" id="msg-${msgId}" data-username="${safeUsername}" data-message-id="${escapeHtml(String(msg.id || ''))}">
            <div class="msg-row">
                ${!isSelf ? `<img src="${escapeHtml(avatarUrl)}" alt="${safeUsername}" class="msg-avatar" onerror="this.onerror=null;this.src='/images/default-avatar.svg'">` : ''}
                <div class="msg-body">
                    ${!isSelf ? `<div class="msg-header"><span class="msg-author">${safeUsername}</span>${isAnonMsg ? '<span style="font-size:0.7rem;margin-left:6px;color:var(--primary-pink);font-weight:600;text-transform:uppercase;letter-spacing:0.05em;">anonymous</span>' : ''}</div>` : ''}
                    ${replyBlock}
                    <div class="msg-bubble ${isSelf ? 'right' : 'left'}">${safeMessage}</div>
                    ${buildMessageReactionMarkup(msg)}
                </div>
                <div class="msg-actions-inline">
                    <button class="msg-more-btn" aria-label="Message options"><i class="bi bi-three-dots-vertical"></i></button>
                    <div class="msg-actions-menu">
                        <button class="msg-reply-btn"><i class="bi bi-reply"></i> Reply</button>
                        <div class="msg-react-action-menu">
                            <button class="msg-react-menu-btn"><i class="bi bi-emoji-smile"></i> React</button>
                            <div class="msg-reaction-picker" data-message-id="${escapeHtml(String(msg.id || ''))}">
                                ${MESSAGE_REACTION_TYPES.map(type => `<button class="msg-reaction-choice" data-reaction="${type}" data-message-id="${escapeHtml(String(msg.id || ''))}" title="${type}">${MESSAGE_REACTION_EMOJIS[type]}</button>`).join('')}
                            </div>
                        </div>
                        ${isSelf ? `<button class="msg-delete-all-btn" style="color:var(--danger);"><i class="bi bi-trash"></i> Delete for Everyone</button>` : ''}
                        <button class="msg-delete-me-btn" style="color:var(--danger);"><i class="bi bi-eye-slash"></i> Delete for Me</button>
                        ${!isSelf ? `<button class="msg-report-btn" style="color:var(--danger);"><i class="bi bi-flag"></i> Report</button>` : ''}
                    </div>
                </div>
            </div>
            <div class="msg-time-below">${time}</div>
        </div>`;
    }).join('');

    if (!preserveScroll || wasScrolledToBottom) container.scrollTop = container.scrollHeight;

    // Attach interaction handlers
    try {
        const msgEls = container.querySelectorAll('.chat-message');
        msgEls.forEach(el => {
            const mid = el.getAttribute('id');
            const msg = (mid && mid.startsWith('msg-'))
                ? messages.find(m => String(m.id).replace(/[^a-zA-Z0-9_-]/g, '_') === mid.replace(/^msg-/, ''))
                : null;

            el.addEventListener('click', (e) => {
                e.stopPropagation();
                document.querySelectorAll('.chat-message.selected').forEach(x => { if (x !== el) x.classList.remove('selected'); });
                el.classList.toggle('selected');
                document.querySelectorAll('.msg-actions-menu.show').forEach(m => m.classList.remove('show'));
            });

            const moreBtn = el.querySelector('.msg-more-btn');
            const menu = el.querySelector('.msg-actions-menu');
            if (moreBtn && menu) {
                moreBtn.addEventListener('click', (ev) => { ev.stopPropagation(); menu.classList.toggle('show'); });
            }

            // Reply preview scroll
            const preview = el.querySelector('.msg-reply-preview');
            if (preview) {
                // Avatar fetch for reply preview (best-effort)
                (async () => {
                    try {
                        const rt = msg && msg.reply_to_meta;
                        const img = preview.querySelector('.reply-avatar');
                        if (img && rt && rt.user_id) {
                            const r = await fetch('/api/users/' + encodeURIComponent(rt.user_id));
                            if (r.ok) { const d = await r.json(); if (d && d.user && d.user.profile_picture_url) img.src = d.user.profile_picture_url; }
                        }
                    } catch (_) {}
                })();

                preview.addEventListener('click', (ev) => {
                    ev.stopPropagation();
                    const targetId = preview.getAttribute('data-target');
                    if (!targetId) return;
                    const targetEl = document.getElementById(targetId);
                    if (targetEl) {
                        targetEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
                        targetEl.classList.add('msg-highlight');
                        setTimeout(() => { try { targetEl.classList.remove('msg-highlight'); } catch (_) {} }, 3000);
                    }
                });
            }

            // Reply button
            const replyBtn = el.querySelector('.msg-reply-btn');
            if (replyBtn) {
                replyBtn.addEventListener('click', (ev) => {
                    ev.stopPropagation();
                    const author = el.getAttribute('data-username') || '';
                    const msgText = msg ? (msg.message || '') : '';
                    if (mid && mid.startsWith('msg-')) {
                        currentReplyTo = mid.replace(/^msg-/, '');
                        if (currentReplyTo) {
                            // Convert safe id back to real id — use the msg object's id
                            if (msg && msg.id) currentReplyTo = msg.id;
                        }
                        showReplyBanner(author, msgText);
                    }
                    document.getElementById('messageInput')?.focus();
                    if (menu) menu.classList.remove('show');
                });
            }

            // Report button
            const reportBtn = el.querySelector('.msg-report-btn');
            if (reportBtn) {
                reportBtn.addEventListener('click', (ev) => {
                    ev.stopPropagation();
                    if (msg && msg.id && window.openMessageReportModal) window.openMessageReportModal(msg.id);
                    if (menu) menu.classList.remove('show');
                });
            }

            // Delete for everyone button
            const deleteAllBtn = el.querySelector('.msg-delete-all-btn');
            if (deleteAllBtn) {
                deleteAllBtn.addEventListener('click', (ev) => {
                    ev.stopPropagation();
                    if (msg && msg.id) openDeleteMessageModal(msg.id, true);
                    if (menu) menu.classList.remove('show');
                });
            }
            // Delete for me button
            const deleteMeBtn = el.querySelector('.msg-delete-me-btn');
            if (deleteMeBtn) {
                deleteMeBtn.addEventListener('click', (ev) => {
                    ev.stopPropagation();
                    if (msg && msg.id) openDeleteMessageModal(msg.id, false);
                    if (menu) menu.classList.remove('show');
                });
            }

            const reactionPicker = el.querySelector('.msg-reaction-picker');
            const reactMenuBtn = el.querySelector('.msg-react-menu-btn');
            if (reactMenuBtn && reactionPicker) {
                reactMenuBtn.addEventListener('click', (ev) => {
                    ev.stopPropagation();
                    document.querySelectorAll('.msg-reaction-picker.show').forEach(p => { if (p !== reactionPicker) p.classList.remove('show'); });
                    reactionPicker.classList.toggle('show');
                });
            }

            el.querySelectorAll('.msg-reaction-choice').forEach(btn => {
                btn.addEventListener('click', async (ev) => {
                    ev.stopPropagation();
                    const reaction = btn.getAttribute('data-reaction');
                    if (!msg || !msg.id || !reaction) return;
                    if (reactionPicker) reactionPicker.classList.remove('show');
                    await reactToMessage(msg.id, reaction);
                });
            });

            el.querySelectorAll('.msg-reaction-chip').forEach(btn => {
                btn.addEventListener('click', async (ev) => {
                    ev.stopPropagation();
                    const reaction = btn.getAttribute('data-reaction');
                    if (!msg || !msg.id || !reaction) return;
                    await reactToMessage(msg.id, reaction);
                });
            });
        });

        document.addEventListener('click', () => {
            document.querySelectorAll('.chat-message.selected').forEach(x => x.classList.remove('selected'));
            document.querySelectorAll('.msg-actions-menu.show').forEach(m => m.classList.remove('show'));
            document.querySelectorAll('.msg-reaction-picker.show').forEach(p => p.classList.remove('show'));
        });
    } catch (_) {}

    // Mark as seen
    try {
        const now = new Date().toISOString();
        if (currentChatType === 'general') setLastSeen(LAST_SEEN_GENERAL_KEY, now);
        else if (currentChatType === 'private') setLastSeen(LAST_SEEN_PRIVATE_KEY, now);
        pollUnreadCounts();
    } catch (_) {}

    tryScrollPending();
}

function tryScrollPending() {
    try {
        const id = window._pendingScrollMessageId;
        if (!id) return;
        const el = document.getElementById('msg-' + id);
        if (el) {
            el.scrollIntoView({ behavior: 'smooth', block: 'center' });
            el.classList.add('msg-highlight');
            setTimeout(() => { try { el.classList.remove('msg-highlight'); } catch (_) {} }, 3000);
            window._pendingScrollMessageId = null;
        }
    } catch (_) {}
}

// ─── Send message ────────────────────────────────────────────────────────────
async function sendMessage() {
    const input = document.getElementById('messageInput');
    const sendBtn = document.getElementById('sendBtn');

    if (_sendingMessage) return;
    const message = input ? input.value.trim() : '';
    if (!message) return;

    _sendingMessage = true;
    if (sendBtn) sendBtn.disabled = true;
    if (input) input.disabled = true;

    let clean = String(message).trim()
        .replace(/<[^>]*>/g, '')
        .replace(/[\x00-\x1F\x7F]/g, '');
    if (clean.length > 1000) clean = clean.substring(0, 1000);

    if (currentChatType === 'private' && !currentRecipientId) {
        window.showAlert && window.showAlert('error', 'Please select a user to start a private chat.');
        _sendingMessage = false;
        if (sendBtn) sendBtn.disabled = false;
        if (input) input.disabled = false;
        return;
    }

    if (currentChatType === 'private' && currentRecipientId && currentUser && String(currentRecipientId) === String(currentUser.id)) {
        window.showAlert && window.showAlert('error', 'You cannot send messages to yourself.', 3000);
        _sendingMessage = false;
        if (sendBtn) sendBtn.disabled = false;
        if (input) input.disabled = false;
        return;
    }

    try {
        const body = { message: clean, chat_type: currentChatType };
        if (currentChatType === 'private' && currentRecipientId) body.recipient_id = currentRecipientId;
        if (currentReplyTo) body.reply_to = currentReplyTo;
        if (isAnonMode && currentChatType === 'general') body.is_anonymous = true;

        const response = await fetch('/api/messages', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            body: JSON.stringify(body)
        });

        let respJson = null;
        try { respJson = await response.json(); } catch (_) {}

        if (!response.ok) {
            if (response.status === 401) { window.location.href = '/login'; return; }
            if (response.status === 403) {
                let errorMsg = (respJson && respJson.error) ? respJson.error : 'You are not allowed to send messages.';
                try {
                    if (respJson && respJson.muted_until) {
                        const until = new Date(respJson.muted_until);
                        const diffMs = until - new Date();
                        const mins = Math.floor(diffMs / 60000);
                        const hrs = Math.floor(mins / 60);
                        const days = Math.floor(hrs / 24);
                        let remaining = days >= 1 ? `${days}d` : hrs >= 1 ? `${hrs}h` : mins >= 1 ? `${mins}m` : 'less than a minute';
                        errorMsg += ` — muted for ${remaining}`;
                    }
                } catch (_) {}
                window.showAlert && window.showAlert('error', errorMsg, 8000);
                return;
            }
            if (response.status === 400 && respJson && respJson.warnings != null) {
                window.showAlert && window.showAlert('warning',
                    (respJson.error || 'Message blocked.') + ' — Warning ' + respJson.warnings + ' of ' + (respJson.maxWarnings || CLIENT_MAX_WARNINGS), 6000);
                return;
            }
            window.showAlert && window.showAlert('error', (respJson && respJson.error) ? respJson.error : 'Failed to send message', 5000);
            return;
        }

        if (input) input.value = '';
        currentReplyTo = null;
        hideReplyBanner();

        // Update last message preview in sidebar
        if (currentChatType === 'private' && currentRecipientId) {
            const contact = _sidebarContacts.find(c => String(c.userId) === String(currentRecipientId));
            if (contact) {
                contact.lastMessage = clean;
                contact.lastMessageTime = new Date().toISOString();
            }
        }

        await loadMessages();
    } catch (err) {
        console.error('Error sending message:', err);
        window.showAlert && window.showAlert('error', 'Failed to send message. Please try again.');
    } finally {
        _sendingMessage = false;
        if (input) input.disabled = false;
        if (sendBtn) sendBtn.disabled = false;
        updateChatInputState();
    }
}

// ─── Old compat wrappers ─────────────────────────────────────────────────────
// Called from URL ?with= param logic and from notification links
async function startPrivateChat(userId, username) {
    let avatarUrl = '/images/default-avatar.svg';
    try {
        const r = await fetch(`/api/users/${encodeURIComponent(userId)}`, { credentials: 'include' });
        if (r.ok) {
            const d = await r.json();
            if (d && d.user && d.user.profile_picture_url) avatarUrl = d.user.profile_picture_url;
            if (d && d.user && (d.user.display_name || d.user.username)) username = d.user.display_name || d.user.username;
        }
    } catch (_) {}
    selectPrivate(userId, username, avatarUrl);
}

function backToContactList() {
    selectGeneral();
    showPeopleSidebarMobile();
}

// closePrivateChat is an alias for selectGeneral
function closePrivateChat() { selectGeneral(); }

// ─── Load older messages ─────────────────────────────────────────────────────
async function loadOlderMessages() {
    if (!oldestMessageId || !hasMoreMessages) return;

    // Show a subtle top-of-list loading indicator
    const container = document.getElementById('chatMessages');
    let indicator = null;
    if (container) {
        indicator = document.createElement('div');
        indicator.id = 'olderMsgsLoader';
        indicator.style.cssText = 'text-align:center;padding:12px;color:var(--dark-gray);font-size:0.85rem;';
        indicator.innerHTML = '<span class="spinner" style="width:18px;height:18px;border-width:2px;"></span>';
        container.prepend(indicator);
    }

    try {
        const params = new URLSearchParams({ limit: '30', before: oldestMessageId });
        if (currentChatType === 'private') {
            if (!currentRecipientId) { if (indicator) indicator.remove(); return; }
            params.set('with', currentRecipientId);
        }

        const url = `/api/messages/${currentChatType}?${params.toString()}`;
        const response = await fetch(url, { credentials: 'include' });
        if (!response.ok) { hasMoreMessages = false; return; }

        const data = await response.json();
        const older = (data && Array.isArray(data.messages)) ? data.messages : [];
        if (older.length === 0) { hasMoreMessages = false; return; }
        if (older.length < 30) hasMoreMessages = false;

        messages = [...older, ...messages];
        await hydrateMessageReactions(messages);
        oldestMessageId = older[0].id;
        displayMessages(true);
    } catch (err) {
        console.error('loadOlderMessages error:', err);
        hasMoreMessages = false;
    } finally {
        if (indicator) indicator.remove();
    }
}

// ─── Update online status ────────────────────────────────────────────────────
async function updateOnlineStatus() {
    try {
        await fetch('/api/online-status', { method: 'POST', credentials: 'include' });
    } catch (_) {}
}

setTimeout(updateOnlineStatus, 2000);
setInterval(updateOnlineStatus, 60000);

// ─── Reply banner ────────────────────────────────────────────────────────────
function showReplyBanner(username, message) {
    const banner = document.getElementById('replyBanner');
    const usernameEl = document.getElementById('replyUsername');
    const messageEl = document.getElementById('replyMessage');
    if (banner) banner.style.display = 'block';
    if (usernameEl) usernameEl.textContent = username;
    if (messageEl) messageEl.textContent = message;
}

function hideReplyBanner() {
    const banner = document.getElementById('replyBanner');
    if (banner) banner.style.display = 'none';
}

function cancelReply() {
    currentReplyTo = null;
    hideReplyBanner();
}

// ─── Delete conversation ─────────────────────────────────────────────────────
function deletePrivateConversation() {
    if (!currentRecipientId) return;
    openDeleteConversationModal(currentRecipientId, currentRecipientName);
}

let _deleteConvTarget = null;

function openDeleteConversationModal(userId, username) {
    _deleteConvTarget = userId;
    let modal = document.getElementById('deleteConversationModal');
    if (!modal) {
        modal = document.createElement('div');
        modal.id = 'deleteConversationModal';
        modal.className = 'modal';
        modal.innerHTML = `
            <div class="modal-content modal-helper-box" style="max-width:420px;">
                <div class="modal-header">
                    <h3 class="modal-title">Delete conversation</h3>
                    <button class="modal-close" aria-label="Close" onclick="closeDeleteConversationModal()">✕</button>
                </div>
                <div class="modal-body">
                    <p id="deleteConvMsg" style="margin:0 0 16px;color:var(--dark-gray);"></p>
                    <div style="display:flex;gap:8px;">
                        <button id="confirmDeleteConversationBtn" class="btn btn-danger" onclick="confirmDeleteConversation()">Delete for You</button>
                        <button class="btn btn-light" onclick="closeDeleteConversationModal()">Cancel</button>
                    </div>
                </div>
            </div>`;
        document.body.appendChild(modal);
        modal.addEventListener('click', (e) => { if (e.target === modal) closeDeleteConversationModal(); });
    }
    const msg = modal.querySelector('#deleteConvMsg');
    if (msg) msg.textContent = `Delete your conversation with ${username || 'this user'}? This only removes it for you.`;
    modal.classList.add('show');
    modal.querySelector('#confirmDeleteConversationBtn')?.focus();
}

function closeDeleteConversationModal() {
    document.getElementById('deleteConversationModal')?.classList.remove('show');
    _deleteConvTarget = null;
}

async function confirmDeleteConversation() {
    if (!_deleteConvTarget) return closeDeleteConversationModal();
    try {
        const resp = await fetch(`/api/messages/private/delete?with=${encodeURIComponent(_deleteConvTarget)}`,
            { method: 'DELETE', credentials: 'include' });
        if (!resp.ok) {
            const d = await resp.json().catch(() => ({}));
            window.showAlert && window.showAlert('error', d.error || 'Failed to delete conversation');
            return;
        }
        window.showAlert && window.showAlert('success', 'Conversation deleted');
        closeDeleteConversationModal();
        // Remove from sidebar
        _sidebarContacts = _sidebarContacts.filter(c => String(c.userId) !== String(_deleteConvTarget));
        renderSidebarContacts(_sidebarContacts);
        selectGeneral();
    } catch (err) {
        window.showAlert && window.showAlert('error', 'Failed to delete conversation');
    }
}

// ─── Delete message ───────────────────────────────────────────────────────────
let _deleteMessageId = null;

function openDeleteMessageModal(messageId, isSelf) {
    _deleteMessageId = messageId;

    let modal = document.getElementById('deleteMessageModal');
    if (!modal) {
        modal = document.createElement('div');
        modal.id = 'deleteMessageModal';
        modal.className = 'modal';
        modal.innerHTML = `
            <div class="modal-content modal-helper-box" style="max-width:420px;">
                <div class="modal-header">
                    <h3 class="modal-title">Delete Message</h3>
                    <button class="modal-close" aria-label="Close" onclick="closeDeleteMessageModal()">✕</button>
                </div>
                <div class="modal-body">
                    <p style="margin:0 0 16px;color:var(--dark-gray);">How would you like to delete this message?</p>
                    <div style="display:flex;flex-direction:column;gap:12px;">
                        <button id="deleteForAllBtn" class="btn btn-danger" onclick="deleteMessage('all')" style="width:100%;">
                            <i class="bi bi-trash"></i> Delete for Everyone
                        </button>
                        <button id="deleteForYouBtn" class="btn btn-outline" onclick="deleteMessage('you')" style="width:100%;">
                            <i class="bi bi-eye-slash"></i> Delete for You
                        </button>
                    </div>
                </div>
                <div class="modal-footer">
                    <button class="btn btn-light" onclick="closeDeleteMessageModal()">Cancel</button>
                </div>
            </div>`;
        document.body.appendChild(modal);
        modal.addEventListener('click', (e) => { if (e.target === modal) closeDeleteMessageModal(); });
    }

    const deleteForAllBtn = modal.querySelector('#deleteForAllBtn');
    if (deleteForAllBtn) deleteForAllBtn.style.display = isSelf ? 'block' : 'none';
    modal.classList.add('show');
    try { modal.querySelector(isSelf ? '#deleteForAllBtn' : '#deleteForYouBtn')?.focus(); } catch (_) {}
}

function closeDeleteMessageModal() {
    document.getElementById('deleteMessageModal')?.classList.remove('show');
    _deleteMessageId = null;
}

async function deleteMessage(type) {
    if (!_deleteMessageId) return;
    const messageId = _deleteMessageId;
    closeDeleteMessageModal();

    try {
        const endpoint = type === 'all'
            ? `/api/messages/${encodeURIComponent(messageId)}/delete-all`
            : `/api/messages/${encodeURIComponent(messageId)}/delete-for-me`;

        const resp = await fetch(endpoint, { method: 'DELETE', credentials: 'include' });
        if (!resp.ok) {
            const d = await resp.json().catch(() => ({}));
            window.showAlert && window.showAlert('error', d.error || 'Failed to delete message');
            return;
        }

        window.showAlert && window.showAlert('success',
            type === 'all' ? 'Message deleted for everyone' : 'Message deleted for you', 2000);
        await loadMessages(true);
    } catch (err) {
        window.showAlert && window.showAlert('error', 'Failed to delete message');
    }
}

// ─── Report message ──────────────────────────────────────────────────────────
window.openMessageReportModal = async function(messageId) {
    const existing = document.getElementById('messageReportModal');
    if (existing) existing.remove();

    let policies = [];
    try {
        const resp = await fetch('/api/policies');
        if (resp.ok) {
            const all = await resp.json();
            policies = all.filter(p => p.category === 'message' || p.category === 'both');
        }
    } catch (_) {}

    const modal = document.createElement('div');
    modal.id = 'messageReportModal';
    modal.className = 'modal';
    modal.style.cssText = 'display:flex;z-index:7000;';
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
                        ${policies.map(p => `<option value="${p.id}" title="${escapeHtml(p.description || '')}">${escapeHtml(p.title)}</option>`).join('')}
                    </select>
                </div>
                <div style="margin-top:16px;">
                    <label for="reportDetails">Additional Details (Optional)</label>
                    <textarea id="reportDetails" class="form-control" placeholder="Provide any additional context..." style="width:100%;height:90px;resize:vertical;"></textarea>
                </div>
            </div>
            <div class="modal-footer">
                <button class="btn btn-light" id="reportCancel">Cancel</button>
                <button class="btn btn-danger" id="reportSubmit"><i class="bi bi-send-fill"></i> Submit Report</button>
            </div>
        </div>`;
    document.body.appendChild(modal);

    const close = () => { try { modal.remove(); } catch (_) {} };
    document.getElementById('reportModalClose').onclick = close;
    document.getElementById('reportCancel').onclick = close;

    document.getElementById('reportSubmit').onclick = async () => {
        const policyId = document.getElementById('reportPolicySelect').value;
        const details = document.getElementById('reportDetails').value.trim();
        if (!policyId) { await window.showModal('Please select a policy violation', 'Error'); return; }

        const selectedPolicy = policies.find(p => String(p.id) === String(policyId));
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
            await window.showModal('Report submitted. Our moderation team will review it.', 'Success');
            close();
        } catch (_) {
            await window.showModal('Failed to submit report', 'Error');
        } finally {
            btn.disabled = false;
        }
    };
};

// ─── Helpers ─────────────────────────────────────────────────────────────────
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

// ─── App sidebar toggle ───────────────────────────────────────────────────────
function toggleSidebar() {
    document.getElementById('sidebar')?.classList.toggle('show');
}

// ─── Logout ───────────────────────────────────────────────────────────────────
async function logout() {
    try {
        const ok = await window.showConfirm('Are you sure you want to logout?', 'Confirm');
        if (!ok) return;
        const resp = await fetch('/api/auth/logout', { method: 'POST', credentials: 'include' });
        if (!resp.ok) { await window.showModal('Failed to log out. Please try again.', 'Error', { small: true }); return; }
        window.location.href = '/login';
    } catch (_) {
        window.location.href = '/login';
    }
}

// ─── Anonymous Mode ───────────────────────────────────────────────────────────
/**
 * Generates a deterministic unique anonymous name from the user's ID.
 * Uses three independent hash functions so the adjective, animal, and
 * number are chosen from different parts of the hash space.
 */
function generateAnonymousName(userId) {
    const adjectives = [
        'Mystic','Shadow','Silent','Bright','Swift','Calm','Bold','Gentle','Wild','Noble',
        'Cosmic','Azure','Crimson','Golden','Jade','Luna','Solar','Stellar','Vivid','Zen',
        'Amber','Cobalt','Dusk','Ember','Frost','Ivory','Navy','Onyx','Pearl','Ruby'
    ];
    const animals = [
        'Fox','Wolf','Hawk','Bear','Deer','Lion','Owl','Raven','Seal','Tiger',
        'Crane','Drake','Eagle','Finch','Goose','Heron','Ibis','Jaguar','Koala','Lynx',
        'Mink','Newt','Orca','Panda','Quail','Robin','Stoat','Toad','Vole','Wren'
    ];
    const str = String(userId || '');
    let h1 = 0, h2 = 0, h3 = 0;
    for (let i = 0; i < str.length; i++) {
        const c = str.charCodeAt(i);
        h1 = Math.imul(h1, 31) + c | 0;
        h2 = Math.imul(h2, 37) + c | 0;
        h3 = Math.imul(h3, 41) + c | 0;
    }
    const adj    = adjectives[Math.abs(h1) % 30];
    const animal = animals[Math.abs(h2) % 30];
    const num    = Math.abs(h3) % 900 + 100;
    return `${adj}${animal}#${num}`;
}

function toggleAnonMode() {
    isAnonMode = !isAnonMode;
    const btn       = document.getElementById('anonToggleBtn');
    const banner    = document.getElementById('anonBanner');
    const nameEl    = document.getElementById('anonNameDisplay');
    const input     = document.getElementById('messageInput');

    if (isAnonMode) {
        if (btn) btn.classList.add('active');
        if (nameEl && currentUser) nameEl.textContent = generateAnonymousName(currentUser.id);
        if (banner) banner.style.display = 'flex';
        if (input) input.placeholder = 'Sending as anonymous...';
    } else {
        if (btn) btn.classList.remove('active');
        if (banner) banner.style.display = 'none';
        if (input) input.placeholder = 'Type a message to everyone...';
    }
}
