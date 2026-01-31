// Reusable site alert/toast system
(function(){
    const containerId = 'siteAlertContainer';

    function ensureContainer() {
        let c = document.getElementById(containerId);
        if (!c) {
            c = document.createElement('div');
            c.id = containerId;
            c.className = 'site-alert-container';
            document.body.appendChild(c);
        }
        return c;
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
        el.addEventListener('click', () => { clearTimeout(t); hide(el); });
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
        return showAlert('info', messageHtml, timeout);
    }

    // minimal sanitizer for alert content
    function escapeHtmlForAlert(s) {
        if (!s) return '';
        return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
    }

    window.showChatNotification = showChatNotification;
})();
