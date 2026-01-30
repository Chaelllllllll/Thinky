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
})();
