// Reusable site alert/toast system
(function(){
    const containerId = 'siteAlertContainer';

    function ensureContainer() {
        let c = document.getElementById(containerId);
        if (!c) {
            c = document.createElement('div');
            c.id = containerId;
            // Force bottom-right placement and high z-index so toasts aren't hidden
            c.className = 'site-alert-container bottom-right';
            c.style.zIndex = '200000';
            document.body.appendChild(c);
        }
        return c;
    }

    // Notification sound handling: prefer a real static file at /audio/notify.wav
    // Many browsers block autoplay until a user gesture; implement a one-time
    // unlock that attempts to play/pause the Audio on the first gesture.
    let _audioEl = null;
    let _audioUnlocked = false;

    function createAudio() {
        if (_audioEl) return _audioEl;
        try {
            // Detect supported formats and prefer MP3 when available per user request.
            const probe = document.createElement('audio');
            const canMp3 = !!(probe.canPlayType && probe.canPlayType('audio/mpeg').replace(/no/, ''));
            const canWav = !!(probe.canPlayType && probe.canPlayType('audio/wav').replace(/no/, ''));
            const srcOrder = [];
            if (canMp3) srcOrder.push('/audio/notify.mp3');
            if (canWav) srcOrder.push('/audio/notify.wav');
            // If detection failed or neither reported support, try MP3 then WAV.
            if (!srcOrder.length) srcOrder.push('/audio/notify.mp3', '/audio/notify.wav');

            _audioEl = new Audio(srcOrder[0]);
            _audioEl.preload = 'auto';
            // remember fallback list for runtime retries
            _audioEl._fallbackSources = srcOrder;
            _audioEl._fallbackIndex = 0;
            return _audioEl;
        } catch (e) {
            _audioEl = null;
            return null;
        }
    }

    // Attempt to programmatically unlock audio by playing then pausing on first gesture
    function tryUnlockAudio() {
        if (_audioUnlocked) return;
        const a = createAudio();
        if (!a) return;
        try {
            const p = a.play();
            if (p && p.then) {
                p.then(() => {
                    try { a.pause(); a.currentTime = 0; } catch (e) {}
                    _audioUnlocked = true;
                    removeUnlockListeners();
                    console.debug('alerts: audio unlocked');
                }).catch(() => {
                    _audioUnlocked = false;
                    // attempt fallback source if available
                    trySwitchAudioFallback(a);
                });
            } else {
                // Older browsers
                try { a.pause(); a.currentTime = 0; _audioUnlocked = true; removeUnlockListeners(); } catch (e) { _audioUnlocked = false; }
            }
        } catch (e) {
            _audioUnlocked = false;
        }
    }

    function unlockHandler() { tryUnlockAudio(); }

    function addUnlockListeners() {
        // Use capture + once so handlers are removed automatically after first event
        try { document.addEventListener('pointerdown', unlockHandler, { once: true, capture: true }); } catch (e) { document.addEventListener('pointerdown', unlockHandler, { once: true }); }
        try { document.addEventListener('keydown', unlockHandler, { once: true, capture: true }); } catch (e) { document.addEventListener('keydown', unlockHandler, { once: true }); }
    }

    function removeUnlockListeners() {
        try { document.removeEventListener('pointerdown', unlockHandler, { capture: true }); } catch (e) {}
        try { document.removeEventListener('keydown', unlockHandler, { capture: true }); } catch (e) {}
    }

    // Ensure listeners are present so the first user gesture unlocks audio
    addUnlockListeners();

    function playNotificationSound() {
        try {
            const a = createAudio();
            if (!a) return;
            a.currentTime = 0;
            const p = a.play();
            if (p && p.catch) {
                p.catch(() => {
                    // If playback was blocked or format unsupported, try fallback
                    trySwitchAudioFallback(a, true);
                    // Ensure unlock listeners remain active
                    addUnlockListeners();
                });
            }
        } catch (e) {
            // ignore playback errors
        }
    }

    function trySwitchAudioFallback(a, attemptPlayAfterSwitch = false) {
        try {
            if (!a || !a._fallbackSources) return;
            const nextIndex = (typeof a._fallbackIndex === 'number') ? a._fallbackIndex + 1 : 1;
            if (nextIndex >= a._fallbackSources.length) return;
            a._fallbackIndex = nextIndex;
            const nextSrc = a._fallbackSources[nextIndex];
            a.src = nextSrc;
            try { a.load(); } catch (e) {}
            if (attemptPlayAfterSwitch) {
                try {
                    a.currentTime = 0;
                    const p2 = a.play();
                    if (p2 && p2.catch) p2.catch(() => {});
                } catch (e) { /* ignore */ }
            }
        } catch (e) { /* ignore */ }
    }

    function showAlert(type, message, timeout = 4000) {
        const container = ensureContainer();
        const el = document.createElement('div');
        el.className = `site-alert site-alert-${type}`;
        el.innerHTML = `<div class="site-alert-content">${message}</div>`;
        console.debug('alerts: creating alert', { type, messagePreview: (typeof message === 'string' ? message.slice(0,80) : null) });
        container.appendChild(el);

        // entrance
        requestAnimationFrame(() => { el.classList.add('show'); });

        const t = setTimeout(() => hide(el), timeout);
        // Default click behavior: hide alert. Other handlers may be attached by caller.
        el.addEventListener('click', () => { clearTimeout(t); hide(el); });
        // Play notification sound if available
        try { playNotificationSound(); } catch (e) { /* ignore */ }
        return el;
    }

    function hide(el) {
        if (!el) return;
        el.classList.remove('show');
        setTimeout(() => { try { el.remove(); } catch(e){} }, 300);
    }

    window.showAlert = showAlert;
    // Show a chat-style notification using the alert/toast system.
    // `opts` = { avatar, username, message, chatType }
    function showChatNotification(opts = {}, timeout = 6000) {
        if (!opts || !opts.username || !opts.message) return null;

        const avatar = opts.avatar || '/images/default-avatar.svg';
        const username = escapeHtmlForAlert(opts.username);
        const text = escapeHtmlForAlert(opts.message);
        const chatType = opts.chatType || 'general';

        const messageHtml = `
            <div class="chat-notif">
                <div class="chat-notif-top">
                    <img src="${avatar}" onerror="this.onerror=null;this.src='/images/default-avatar.svg'" class="chat-notif-avatar"/>
                    <div class="chat-notif-user">${username}</div>
                </div>
                <div class="chat-notif-body">${text}</div>
                <div class="chat-notif-type">${chatType === 'private' ? 'Personal' : 'General'}</div>
            </div>
        `;

        console.debug('alerts: showChatNotification', { username: opts.username, chatType: opts.chatType });
        const alertEl = showAlert('info', messageHtml, timeout);

        // Make the toast clickable to open chat and scroll to message when `opts.msgId` is provided.
        try {
            if (alertEl && opts && opts.msgId) {
                alertEl.style.cursor = 'pointer';
                alertEl.addEventListener('click', (e) => {
                    try { e.stopPropagation(); } catch (x) {}
                    // Close the alert
                    try { alertEl.remove(); } catch (x) {}
                    // Build URL to chat page with scrollTo param
                    const target = '/chat.html';
                    const qs = new URLSearchParams();
                    qs.set('scrollTo', String(opts.msgId));
                    // If private chat, include withUser param to open correct thread
                    if (opts.chatType === 'private' && opts.recipientId) qs.set('with', String(opts.recipientId));
                    // Navigate
                    window.location.href = target + '?' + qs.toString();
                });
            }
        } catch (e) { /* ignore */ }

        return alertEl;
    }

    // minimal sanitizer for alert content
    function escapeHtmlForAlert(s) {
        if (!s) return '';
        return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
    }

    window.showChatNotification = showChatNotification;

    // Test helper to manually show a notification from console: window.testNotify()
    window.testNotify = function() {
        try {
            window.showChatNotification({ avatar: '/images/default-avatar.svg', username: 'Test User', message: 'This is a visual test notification', chatType: 'general' }, 6000);
            // Try to play the notification sound (may be blocked until a gesture).
            try { playNotificationSound(); } catch (e) { /* ignore */ }
            console.debug('alerts: testNotify fired');
        } catch (e) {
            console.debug('alerts: testNotify error', e && e.message ? e.message : e);
        }
    };

    // Expose helpers to allow manual unlocking from the console
    window.enableNotificationSound = function() { try { tryUnlockAudio(); } catch (e) {} };
    window.isNotificationSoundUnlocked = function() { return !!_audioUnlocked; };
})();
