(function(){
    // Provide a global logout() that prefers the modal helper when available
    async function doLogout() {
        try {
            const confirmFn = (typeof window.showConfirm === 'function') ? window.showConfirm : (msg, title) => Promise.resolve(confirm(msg));
            const ok = await confirmFn('Are you sure you want to logout?', 'Confirm');
            if (!ok) return;

            const resp = await fetch('/api/auth/logout', {
                method: 'POST',
                credentials: 'include'
            });

            if (!resp.ok) {
                const showModal = (typeof window.showModal === 'function') ? window.showModal : (msg, title) => { alert((title?title+': ':'')+msg); return Promise.resolve(); };
                await showModal('Failed to log out. Please try again.', 'Error', { small: true });
                return;
            }

            window.location.href = '/login';
        } catch (err) {
            console.error('Logout error:', err);
            try {
                const showModal = (typeof window.showModal === 'function') ? window.showModal : (msg, title) => { alert((title?title+': ':'')+msg); return Promise.resolve(); };
                await showModal('An error occurred while logging out. Redirecting to login.', 'Error', { small: true });
            } catch (e) {}
            window.location.href = '/login';
        }
    }

    // Expose globally
    window.logout = doLogout;
})();
