// Notifications system for reviewer reactions, comments, and messages
(function() {
    const POLL_INTERVAL = 30000; // Poll every 30 seconds
    let pollInterval = null;
    let notificationsCache = [];
    let isInitialized = false;

    // Initialize notifications on page load
    function initNotifications() {
        const notifBtns = document.querySelectorAll('.notification-btn');
        const notifDropdowns = document.querySelectorAll('.notification-dropdown');

        if (notifBtns.length === 0 || notifDropdowns.length === 0) {
            console.debug('Notification elements not found on this page');
            return;
        }

        // Prevent double initialization
        if (isInitialized) {
            console.debug('Notifications already initialized');
            return;
        }

        isInitialized = true;
        console.debug('Notifications initialized for', notifBtns.length, 'button(s)');

        // Setup each notification button and dropdown
        notifBtns.forEach((btn, index) => {
            const dropdown = notifDropdowns[index];
            if (!dropdown) return;

            // Toggle dropdown on button click
            btn.addEventListener('click', async (e) => {
                e.stopPropagation();
                e.preventDefault();
                
                // Close all other dropdowns
                notifDropdowns.forEach((d, i) => {
                    if (i !== index) {
                        d.style.display = 'none';
                    }
                });

                const isVisible = dropdown.style.display === 'block';
                
                console.debug('Notification button clicked, current visibility:', isVisible);
                
                if (isVisible) {
                    dropdown.style.display = 'none';
                } else {
                    dropdown.style.display = 'block';
                    console.debug('Dropdown should now be visible');
                    await loadNotifications();
                }
            });

            // Close dropdown when clicking outside
            document.addEventListener('click', (e) => {
                if (!btn.contains(e.target) && !dropdown.contains(e.target)) {
                    dropdown.style.display = 'none';
                }
            });
        });

        // Mark all as read buttons
        const markAllReadBtns = document.querySelectorAll('.mark-all-read-btn');
        markAllReadBtns.forEach(btn => {
            btn.addEventListener('click', async (e) => {
                e.preventDefault();
                await markAllAsRead();
            });
        });

        // Start polling for new notifications
        startPolling();

        // Initial load
        loadNotifications();
    }

    // Load notifications from API
    async function loadNotifications() {
        try {
            const response = await fetch('/api/notifications?limit=20', {
                credentials: 'include'
            });

            if (!response.ok) {
                console.error('Failed to fetch notifications:', response.statusText);
                return;
            }

            const data = await response.json();
            notificationsCache = data.notifications || [];
            updateBadge(data.unreadCount || 0);
            renderNotifications(notificationsCache);
        } catch (error) {
            console.error('Error loading notifications:', error);
        }
    }

    // Update notification badge
    function updateBadge(count) {
        const badges = document.querySelectorAll('.notification-badge');
        badges.forEach(badge => {
            if (count > 0) {
                badge.textContent = count > 99 ? '99+' : count.toString();
                badge.style.display = 'inline-block';
            } else {
                badge.style.display = 'none';
            }
        });
    }

    // Render notifications in dropdown
    function renderNotifications(notifications) {
        const lists = document.querySelectorAll('.notification-list');
        lists.forEach(list => {
            if (notifications.length === 0) {
                list.innerHTML = '<div class="notification-empty">No notifications</div>';
                return;
            }

            list.innerHTML = notifications.map(notif => {
                const unreadClass = notif.is_read ? '' : 'unread';
                const avatar = notif.related_user?.profile_picture_url || '/images/default-avatar.svg';
                const timeAgo = formatTimeAgo(new Date(notif.created_at));
                
                return `
                    <div class="notification-item ${unreadClass}" data-id="${notif.id}" data-link="${notif.link}">
                        <img src="${avatar}" 
                             onerror="this.src='/images/default-avatar.svg'" 
                             alt="avatar" 
                             class="notification-avatar">
                        <div class="notification-content">
                            <div class="notification-title">${escapeHtml(notif.title)}</div>
                            <div class="notification-message">${escapeHtml(notif.message)}</div>
                            <div class="notification-time">${timeAgo}</div>
                        </div>
                    </div>
                `;
            }).join('');

            // Add click handlers to notification items
            list.querySelectorAll('.notification-item').forEach(item => {
                item.addEventListener('click', async () => {
                    const notifId = item.dataset.id;
                    const link = item.dataset.link;
                    
                    // Mark as read
                    await markAsRead(notifId);
                    
                    // Navigate to the link
                    if (link) {
                        window.location.href = link;
                    }
                });
            });
        });
    }

    // Mark a notification as read
    async function markAsRead(notifId) {
        try {
            await fetch(`/api/notifications/${notifId}/read`, {
                method: 'PUT',
                credentials: 'include'
            });

            // Update local cache
            const notif = notificationsCache.find(n => n.id === notifId);
            if (notif) {
                notif.is_read = true;
            }

            // Update badge
            const unreadCount = notificationsCache.filter(n => !n.is_read).length;
            updateBadge(unreadCount);
        } catch (error) {
            console.error('Error marking notification as read:', error);
        }
    }

    // Mark all notifications as read
    async function markAllAsRead() {
        try {
            await fetch('/api/notifications/read-all', {
                method: 'PUT',
                credentials: 'include'
            });

            // Update local cache
            notificationsCache.forEach(notif => {
                notif.is_read = true;
            });

            // Update UI
            updateBadge(0);
            renderNotifications(notificationsCache);
        } catch (error) {
            console.error('Error marking all notifications as read:', error);
        }
    }

    // Start polling for new notifications
    function startPolling() {
        if (pollInterval) {
            clearInterval(pollInterval);
        }

        let prevUnreadCount = -1;
        pollInterval = setInterval(async () => {
            try {
                const response = await fetch('/api/notifications?unread=true', {
                    credentials: 'include'
                });

                if (response.ok) {
                    const data = await response.json();
                    const newCount = data.unreadCount || 0;
                    updateBadge(newCount);
                    // When new notifications have arrived since the last poll,
                    // refresh the full list so the dropdown reflects them immediately
                    // without the user needing to close and reopen it.
                    if (prevUnreadCount >= 0 && newCount > prevUnreadCount) {
                        await loadNotifications();
                    }
                    prevUnreadCount = newCount;
                }
            } catch (error) {
                console.debug('Notification polling error:', error);
            }
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
        div.textContent = text;
        return div.innerHTML;
    }

    // Don't auto-start - wait for manual initialization after login detection
    // The notification button is dynamically created after login, so we need to
    // wait for that to happen before initializing

    // Expose functions globally if needed
    window.notificationSystem = {
        init: initNotifications,
        loadNotifications,
        markAsRead,
        markAllAsRead
    };
})();
