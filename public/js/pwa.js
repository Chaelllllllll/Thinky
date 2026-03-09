/**
 * Thinky PWA — service worker registration, push subscription, install prompt
 *
 * Included on: index.html, dashboard.html, reviewer.html, user.html, profile.html
 */
(async function () {
  'use strict';

  if (!('serviceWorker' in navigator)) return;

  // ── 1. Register Service Worker ───────────────────────────────────────────────
  let swReg = null;
  try {
    swReg = await navigator.serviceWorker.register('/sw.js', { scope: '/' });
  } catch (err) {
    console.warn('[PWA] SW registration failed:', err);
    return;
  }

  // ── 2. Auth check — all modals are login-gated ───────────────────────────────
  async function isLoggedIn() {
    try {
      const res = await fetch('/api/auth/me', { credentials: 'include' });
      return res.ok;
    } catch {
      return false;
    }
  }

  // ── 3. Push subscription ─────────────────────────────────────────────────────
  const PENDING_SUB_KEY = 'pwa_pending_push_sub';

  function urlBase64ToUint8Array(base64String) {
    const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
    const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
    const raw = atob(base64);
    return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)));
  }

  async function sendSubToServer(sub) {
    try {
      const payload = sub.toJSON ? sub.toJSON() : sub;
      const res = await fetch('/api/push/subscribe', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (res.ok) {
        localStorage.removeItem(PENDING_SUB_KEY);
        console.log('[PWA] Push subscription saved to server');
      } else {
        const body = await res.json().catch(() => ({}));
        console.warn(`[PWA] Push subscribe failed (${res.status}):`, body.error || 'unknown');
        localStorage.setItem(PENDING_SUB_KEY, JSON.stringify(payload));
      }
    } catch (err) {
      console.warn('[PWA] Push subscribe network error:', err);
      try {
        const payload = sub.toJSON ? sub.toJSON() : sub;
        localStorage.setItem(PENDING_SUB_KEY, JSON.stringify(payload));
      } catch {}
    }
  }

  // Flush any subscription that was stored while the user wasn't yet logged in
  async function flushPendingSub() {
    const stored = localStorage.getItem(PENDING_SUB_KEY);
    if (!stored) return;
    try {
      const sub = JSON.parse(stored);
      const res = await fetch('/api/push/subscribe', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(sub),
      });
      if (res.ok) {
        localStorage.removeItem(PENDING_SUB_KEY);
        console.log('[PWA] Pending push subscription flushed');
      }
    } catch {}
  }

  async function subscribeToPush() {
    if (!('PushManager' in window)) return;
    if (Notification.permission === 'denied') return;

    await flushPendingSub();

    try {
      const keyRes = await fetch('/api/push/vapid-public-key', { credentials: 'include' });
      if (!keyRes.ok) return;
      const { publicKey } = await keyRes.json();
      if (!publicKey) return;

      const existing = await swReg.pushManager.getSubscription();
      if (existing) {
        await sendSubToServer(existing);
        return;
      }

      const sub = await swReg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(publicKey),
      });
      await sendSubToServer(sub);
    } catch (err) {
      if (err.name === 'AbortError' || err.name === 'NotSupportedError') {
        // Push service unreachable or unsupported — device-level failure, no point retrying
        console.warn('[PWA] Push service unavailable:', err.message);
      } else {
        console.warn('[PWA] Push subscribe error:', err);
      }
    }
  }

  async function requestAndSubscribe() {
    if (!('Notification' in window)) return;
    if (Notification.permission === 'granted') {
      await subscribeToPush();
      return;
    }
    if (Notification.permission === 'default') {
      const perm = await Notification.requestPermission();
      if (perm === 'granted') await subscribeToPush();
    }
  }

  // ── 4. Notification permission modal ─────────────────────────────────────────
  function isNotifPromptPage() {
    const p = window.location.pathname;
    return p === '/' || p === '/index.html' || p === '/dashboard.html' ||
           p === '/user.html' || p === '/profile.html';
  }

  async function maybeShowNotifModal() {
    if (!('Notification' in window)) return;
    if (Notification.permission !== 'default') return;
    if (!isNotifPromptPage()) return;
    if (!(await isLoggedIn())) return;
    const modal = document.getElementById('pwaNotifModal');
    if (!modal) return;
    modal.classList.add('show');
  }

  window.pwaEnableNotif = async function () {
    const modal = document.getElementById('pwaNotifModal');
    if (modal) modal.classList.remove('show');
    await requestAndSubscribe();
  };

  window.pwaNotifDismiss = function () {
    const modal = document.getElementById('pwaNotifModal');
    if (modal) modal.classList.remove('show');
  };

  // ── 5. Install prompt (A2HS) ─────────────────────────────────────────────────
  const INSTALL_DISMISSED_KEY = 'pwa_install_dismissed_at';
  const INSTALL_INTERVAL_MS   = 30 * 60 * 1000; // 30 minutes

  let deferredPrompt = null;

  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredPrompt = e;
    maybeShowInstallModal();
  });

  function isStandalone() {
    return (
      window.matchMedia('(display-mode: standalone)').matches ||
      window.navigator.standalone === true ||
      document.referrer.includes('android-app://')
    );
  }

  async function maybeShowInstallModal() {
    if (isStandalone() || !deferredPrompt) return;
    if (!(await isLoggedIn())) return;

    const lastDismissed = parseInt(localStorage.getItem(INSTALL_DISMISSED_KEY) || '0', 10);
    if (Date.now() - lastDismissed < INSTALL_INTERVAL_MS) return;

    showInstallModal();
  }

  function showInstallModal() {
    const modal = document.getElementById('pwaInstallModal');
    if (!modal) return;
    modal.classList.add('show');
  }

  function hideInstallModal(permanently) {
    const modal = document.getElementById('pwaInstallModal');
    if (modal) modal.classList.remove('show');
    if (!permanently) {
      localStorage.setItem(INSTALL_DISMISSED_KEY, String(Date.now()));
    }
  }

  window.pwaInstall = async function () {
    if (!deferredPrompt) return;
    deferredPrompt.prompt();
    const { outcome } = await deferredPrompt.userChoice;
    deferredPrompt = null;
    hideInstallModal(outcome === 'accepted');
    if (outcome === 'accepted') await requestAndSubscribe();
  };

  window.pwaInstallDismiss = function () {
    hideInstallModal(false);
  };

  setInterval(() => maybeShowInstallModal(), INSTALL_INTERVAL_MS);

  // ── 6. Initialise on page load ───────────────────────────────────────────────
  window.addEventListener('load', async () => {
    if (isStandalone()) {
      // Already installed as app — silently sync push subscription
      requestAndSubscribe();
      return;
    }

    // Try to flush any pending subscription first (user may have just logged in)
    if (Notification.permission === 'granted') {
      await subscribeToPush();
    } else if (Notification.permission === 'default') {
      // Show our persuasion modal 1.5 s after load (auth-gated inside)
      setTimeout(maybeShowNotifModal, 1500);
    }
  });
})();
