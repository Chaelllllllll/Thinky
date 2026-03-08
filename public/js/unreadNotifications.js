// Shared unread notifications polling for chat badges (sidebar + chat tabs)
(function(){
    const LAST_SEEN_GENERAL_KEY = 'chat_last_seen_general';
    const LAST_SEEN_PRIVATE_KEY = 'chat_last_seen_private';
    const POLL_MS = 30000;
    const BACKOFF_MS = 60000;
    let sharedInterval = null;
    let _backoffTimer = null;

    function getLastSeen(key) {
        return localStorage.getItem(key) || null;
    }
    function setLastSeen(key, iso) {
        try { localStorage.setItem(key, iso); } catch (e) {}
    }

    function updateBadges(counts) {
        const g = counts && counts.general ? parseInt(counts.general,10) : 0;
        const p = counts && counts.private ? parseInt(counts.private,10) : 0;

        const gEl = document.getElementById('generalUnreadBadge');
        const pEl = document.getElementById('personalUnreadBadge');
        const sideEl = document.getElementById('sidebarChatBadge');

        if (gEl) { if (g>0){ gEl.style.display='inline-block'; gEl.textContent = g>99?'99+':String(g); } else gEl.style.display='none'; }
        if (pEl) { if (p>0){ pEl.style.display='inline-block'; pEl.textContent = p>99?'99+':String(p); } else pEl.style.display='none'; }
        if (sideEl) {
            const total = (g||0) + (p||0);
            if (total>0) { sideEl.style.display='inline-block'; sideEl.textContent = total>99 ? '99+' : String(total); }
            else { sideEl.style.display='none'; }
        }
    }

    async function pollSharedUnread() {
        try {
            const lastSeenGeneral = encodeURIComponent(getLastSeen(LAST_SEEN_GENERAL_KEY) || '1970-01-01T00:00:00Z');
            const lastSeenPrivate = encodeURIComponent(getLastSeen(LAST_SEEN_PRIVATE_KEY) || '1970-01-01T00:00:00Z');
            const url = `/api/messages/unread?lastSeenGeneral=${lastSeenGeneral}&lastSeenPrivate=${lastSeenPrivate}`;
            // Explicitly avoid cached responses
            const resp = await fetch(url, { credentials: 'include', cache: 'no-store' });
            if (resp.status === 429) {
                console.debug('unreadNotifications: rate limited (429), backing off');
                if (sharedInterval) { clearInterval(sharedInterval); sharedInterval = null; }
                if (_backoffTimer) clearTimeout(_backoffTimer);
                _backoffTimer = setTimeout(() => {
                    _backoffTimer = null;
                    sharedInterval = setInterval(pollSharedUnread, POLL_MS);
                }, BACKOFF_MS);
                return null;
            }
            if (!resp.ok) {
                console.debug('unreadNotifications: unread fetch not ok', resp.status, resp.statusText);
                return null;
            }
            const data = await resp.json();
            console.debug('unreadNotifications: pollSharedUnread result', data);
            updateBadges(data);
            return data;
        } catch (e) {
            console.debug('unreadNotifications: pollSharedUnread error', e && (e.message || e));
            return null;
        }
    }

    function startSharedUnreadPolling() {
        if (sharedInterval) clearInterval(sharedInterval);
        if (_backoffTimer) { clearTimeout(_backoffTimer); _backoffTimer = null; }
        // Ensure keys exist (default to epoch so new messages since first run are counted)
        if (!getLastSeen(LAST_SEEN_GENERAL_KEY)) setLastSeen(LAST_SEEN_GENERAL_KEY, new Date().toISOString());
        if (!getLastSeen(LAST_SEEN_PRIVATE_KEY)) setLastSeen(LAST_SEEN_PRIVATE_KEY, new Date().toISOString());
        pollSharedUnread();
        sharedInterval = setInterval(pollSharedUnread, POLL_MS);
    }

    // Expose for other scripts (e.g., `chat.js` when user opens chat should update last-seen)
    window.startSharedUnreadPolling = startSharedUnreadPolling;
    window.pollSharedUnread = pollSharedUnread;
    window.sharedSetLastSeen = setLastSeen;
    window.sharedGetLastSeen = getLastSeen;

    // Auto-start on pages that include this script, but only after
    // verifying the client is authenticated. This prevents silent 401s
    // from hiding badge updates when the session cookie isn't sent.
    document.addEventListener('DOMContentLoaded', async () => {
        try {
            const resp = await fetch('/api/auth/me', { credentials: 'include' });
            if (resp.ok) {
                startSharedUnreadPolling();
            } else {
                // Not authenticated: don't start polling (avoids noise).
                // Log to console for easier debugging in production.
                console.info('Unread polling not started: client not authenticated');
            }
        } catch (e) {
            // Network errors: avoid starting polling to prevent repeated failures
            console.info('Unread polling not started due to network error');
        }
    });
})();
