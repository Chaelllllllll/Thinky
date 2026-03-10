// Notifications system for reviewer reactions, comments, and messages
(function() {
    const POLL_INTERVAL = 30000;
    const PAGE_LIMIT = 10;

    let pollInterval = null;
    let notificationsCache = [];
    let isInitialized = false;

    // Lazy loading state
    let _offset = 0;
    let _hasMore = false;
    let _isLoadingMore = false;

    async function tryOpenNotificationLinkInModal(link) {
        try {
            if (!link) return false;
            const url = new URL(link, window.location.origin);
            const path = (url.pathname || '').toLowerCase();
            if (path !== '/chat.html' && path !== '/chat') return false;

            const withUser = url.searchParams.get('with') || '';
            const msgId = url.searchParams.get('scrollTo') || '';
            const chatType = withUser ? 'private' : 'general';

            if (typeof window.openMessageModalFromNotification === 'function') {
                const opened = await window.openMessageModalFromNotification({
                    chatType,
                    withUser: withUser || null,
                    msgId: msgId || null
                });
                return !!opened;
            }

            return false;
        } catch (_) {
            return false;
        }
    }

    // Initialize notifications on page load
    function initNotifications() {
        const notifBtns = document.querySelectorAll('.notification-btn');
        const notifDropdowns = document.querySelectorAll('.notification-dropdown');

        if (notifBtns.length === 0 || notifDropdowns.length === 0) return;

        // Setup each notification button and dropdown (skip already-bound ones)
        notifBtns.forEach((btn, index) => {
            const dropdown = notifDropdowns[index];
            if (!dropdown) return;
            if (btn.dataset.notifBound === '1') return; // already has listener
            btn.dataset.notifBound = '1';

            // Toggle dropdown on button click
            btn.addEventListener('click', async (e) => {
                e.stopPropagation();
                e.preventDefault();

                // Close all other dropdowns
                notifDropdowns.forEach((d, i) => { if (i !== index) d.style.display = 'none'; });

                const isVisible = dropdown.style.display === 'block';
                if (isVisible) {
                    dropdown.style.display = 'none';
                } else {
                    dropdown.style.display = 'block';
                    // Reset and load first page
                    notificationsCache = [];
                    _offset = 0;
                    _hasMore = false;
                    _isLoadingMore = false;
                    await loadNotifications(true);
                }
            });

            // Close dropdown when clicking outside
            document.addEventListener('click', (e) => {
                if (!btn.contains(e.target) && !dropdown.contains(e.target)) {
                    dropdown.style.display = 'none';
                }
            });
        });

        // Mark all as read buttons (skip already-bound)
        document.querySelectorAll('.mark-all-read-btn').forEach(btn => {
            if (btn.dataset.notifBound === '1') return;
            btn.dataset.notifBound = '1';
            btn.addEventListener('click', async (e) => {
                e.preventDefault();
                await markAllAsRead();
            });
        });

        // Infinite scroll on notification lists
        document.querySelectorAll('.notification-list').forEach(list => {
            if (list.dataset.scrollBound === '1') return;
            list.dataset.scrollBound = '1';
            list.addEventListener('scroll', async () => {
                if (_isLoadingMore || !_hasMore) return;
                if (list.scrollHeight - list.scrollTop - list.clientHeight < 80) {
                    await loadNotifications(false);
                }
            });
        });

        if (!isInitialized) {
            startPolling();
            isInitialized = true;
        }
    }

    // Load notifications — reset=true replaces list, reset=false appends
    async function loadNotifications(reset = true) {
        if (_isLoadingMore) return;
        if (!reset && !_hasMore) return;

        _isLoadingMore = true;

        const lists = document.querySelectorAll('.notification-list');

        if (reset) {
            lists.forEach(list => {
                list.innerHTML = '<div class="notification-loading">Loading...</div>';
            });
        } else {
            // Show bottom spinner
            lists.forEach(list => {
                if (!list.querySelector('.notif-more-spinner')) {
                    const s = document.createElement('div');
                    s.className = 'notif-more-spinner notification-loading';
                    s.textContent = 'Loading more...';
                    list.appendChild(s);
                }
            });
        }

        try {
            const response = await fetch(`/api/notifications?limit=${PAGE_LIMIT}&offset=${_offset}`, {
                credentials: 'include'
            });

            if (!response.ok) return;

            const data = await response.json();
            const fresh = data.notifications || [];

            _hasMore = fresh.length >= PAGE_LIMIT;
            _offset += fresh.length;

            if (reset) {
                notificationsCache = fresh;
            } else {
                notificationsCache = [...notificationsCache, ...fresh];
            }

            updateBadge(data.unreadCount ?? notificationsCache.filter(n => !n.is_read).length);

            lists.forEach(list => {
                // Remove spinners
                list.querySelectorAll('.notification-loading, .notif-more-spinner').forEach(el => el.remove());

                if (reset && fresh.length === 0) {
                    list.innerHTML = '<div class="notification-empty">No notifications</div>';
                    return;
                }

                const html = fresh.map(notif => buildNotifHtml(notif)).join('');
                if (reset) {
                    list.innerHTML = html;
                } else {
                    list.insertAdjacentHTML('beforeend', html);
                }

                // Attach click handlers only to new items
                list.querySelectorAll('.notification-item:not([data-bound])').forEach(item => {
                    item.dataset.bound = '1';
                    item.addEventListener('click', async () => {
                        const notifId = item.dataset.id;
                        const link = item.dataset.link;
                        await markAsRead(notifId);
                        if (link) {
                            const handled = await tryOpenNotificationLinkInModal(link);
                            if (!handled) window.location.href = link;
                        }
                    });
                });
            });
        } catch (error) {
            console.error('Error loading notifications:', error);
        } finally {
            _isLoadingMore = false;
            document.querySelectorAll('.notif-more-spinner').forEach(s => s.remove());
        }
    }

    function buildNotifHtml(notif) {
        const unreadClass = notif.is_read ? '' : 'unread';
        const avatar = (notif.related_user && notif.related_user.profile_picture_url)
            ? notif.related_user.profile_picture_url : '/images/default-avatar.svg';
        const timeAgo = formatTimeAgo(new Date(notif.created_at));
        return `
            <div class="notification-item ${unreadClass}" data-id="${notif.id}" data-link="${notif.link || ''}">
                <img src="${escapeHtml(avatar)}" onerror="this.src='/images/default-avatar.svg'"
                     alt="avatar" class="notification-avatar">
                <div class="notification-content">
                    <div class="notification-title">${escapeHtml(notif.title)}</div>
                    <div class="notification-message">${escapeHtml(notif.message)}</div>
                    <div class="notification-time">${timeAgo}</div>
                </div>
            </div>`;
    }

    // Update notification badge
    function updateBadge(count) {
        document.querySelectorAll('.notification-badge').forEach(badge => {
            if (count > 0) {
                badge.textContent = count > 99 ? '99+' : count.toString();
                badge.style.display = 'inline-block';
            } else {
                badge.style.display = 'none';
            }
        });
    }

    // Mark a notification as read
    async function markAsRead(notifId) {
        try {
            await fetch(`/api/notifications/${notifId}/read`, { method: 'PUT', credentials: 'include' });
            const notif = notificationsCache.find(n => n.id === notifId);
            if (notif) notif.is_read = true;
            updateBadge(notificationsCache.filter(n => !n.is_read).length);
        } catch (error) {
            console.error('Error marking notification as read:', error);
        }
    }

    // Mark all notifications as read
    async function markAllAsRead() {
        try {
            await fetch('/api/notifications/read-all', { method: 'PUT', credentials: 'include' });
            notificationsCache.forEach(n => { n.is_read = true; });
            updateBadge(0);
            // Visually remove unread highlight
            document.querySelectorAll('.notification-item.unread').forEach(el => el.classList.remove('unread'));
        } catch (error) {
            console.error('Error marking all notifications as read:', error);
        }
    }

    // Start polling for unread count (does not replace list)
    function startPolling() {
        if (pollInterval) clearInterval(pollInterval);

        let prevUnreadCount = -1;
        pollInterval = setInterval(async () => {
            try {
                const response = await fetch('/api/notifications?unread=true&limit=1', { credentials: 'include' });
                if (response.ok) {
                    const data = await response.json();
                    const newCount = data.unreadCount || 0;
                    updateBadge(newCount);
                    // If new notifications arrived, reset list next time dropdown opens
                    if (prevUnreadCount >= 0 && newCount > prevUnreadCount) {
                        // Mark cache stale so next open reloads
                        _offset = 0;
                        notificationsCache = [];
                    }
                    prevUnreadCount = newCount;
                }
            } catch (_) {}
        }, POLL_INTERVAL);
    }

    // Format time ago
    function formatTimeAgo(date) {
        const seconds = Math.floor((new Date() - date) / 1000);
        if (seconds < 60) return 'just now';
        if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
        if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
        if (seconds < 604800) return `${Math.floor(seconds / 86400)}d ago`;
        return date.toLocaleDateString();
    }

    // Escape HTML to prevent XSS
    function escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text || '';
        return div.innerHTML;
    }

    window.notificationSystem = {
        init: initNotifications,
        loadNotifications: () => loadNotifications(true),
        markAsRead,
        markAllAsRead
    };
})();
