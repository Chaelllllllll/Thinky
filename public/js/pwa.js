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

  // ── 2. Push subscription ─────────────────────────────────────────────────────
  async function subscribeToPush() {
    if (!('PushManager' in window)) return;
    if (Notification.permission === 'denied') return;

    // Retry any subscription that was created before the user was logged in
    await flushPendingSub();

    try {
      const keyRes = await fetch('/api/push/vapid-public-key', { credentials: 'include' });
      if (!keyRes.ok) return;
      const { publicKey } = await keyRes.json();
      if (!publicKey) return;

      const existing = await swReg.pushManager.getSubscription();
      if (existing) {
        // Ensure server has this subscription stored
        await sendSubToServer(existing);
        return;
      }

      const sub = await swReg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(publicKey),
      });
      await sendSubToServer(sub);
    } catch (err) {
      console.warn('[PWA] Push subscribe error:', err);
    }
  }

  const PENDING_SUB_KEY = 'pwa_pending_push_sub';

  async function sendSubToServer(sub) {
    try {
      const payload = sub.toJSON ? sub.toJSON() : sub; // normalise PushSubscription or plain object
      const res = await fetch('/api/push/subscribe', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (res.ok) {
        localStorage.removeItem(PENDING_SUB_KEY);
        console.log('[PWA] Push subscription saved to server ✓');
      } else {
        const body = await res.json().catch(() => ({}));
        console.warn(`[PWA] Push subscribe failed (${res.status}):`, body.error || 'unknown');
        // Store for retry on next page load (handles 401 not-logged-in AND 500 server errors)
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

  // Retry any subscription saved while the user wasn't logged in (or server had a transient error)
  async function flushPendingSub() {
    const stored = localStorage.getItem(PENDING_SUB_KEY);
    if (!stored) return;
    console.log('[PWA] Retrying pending push subscription...');
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
        console.log('[PWA] Pending push subscription flushed ✓');
      } else {
        console.warn(`[PWA] Pending flush failed (${res.status}) — will retry next visit`);
      }
    } catch (err) {
      console.warn('[PWA] Pending flush network error:', err);
    }
  }

  function urlBase64ToUint8Array(base64String) {
    const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
    const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
    const raw = atob(base64);
    return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)));
  }

  // Request permission then subscribe (only if user is logged in — server check)
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

  // ── 3. Notification permission modal ─────────────────────────────────────────
  function isNotifPromptPage() {
    const p = window.location.pathname;
    return p === '/' || p === '/index.html' || p === '/dashboard.html' ||
           p === '/user.html' || p === '/profile.html';
  }

  function maybeShowNotifModal() {
    if (!('Notification' in window)) return;
    if (Notification.permission !== 'default') return; // already granted or denied
    if (!isNotifPromptPage()) return;
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
    // No permanent snooze — modal reappears on next visit until they enable
  };

  // ── 4. Install prompt (A2HS) ─────────────────────────────────────────────────
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

  // Pages that should show the install modal on every visit (not just on snooze interval)
  function isShowEveryVisit() {
    const p = window.location.pathname;
    return p === '/' || p === '/index.html' || p === '/reviewer.html';
  }

  async function maybeShowInstallModal() {
    if (isStandalone() || !deferredPrompt) return;

    if (isShowEveryVisit()) {
      // Show every visit unless the user is already push-subscribed
      const alreadySubscribed =
        Notification.permission === 'granted' &&
        !!(await swReg.pushManager.getSubscription().catch(() => null));
      if (alreadySubscribed) return;
    } else {
      // Other pages: respect the 30-minute snooze
      const lastDismissed = parseInt(localStorage.getItem(INSTALL_DISMISSED_KEY) || '0', 10);
      if (Date.now() - lastDismissed < INSTALL_INTERVAL_MS) return;
    }

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

  // Install button handler
  window.pwaInstall = async function () {
    if (!deferredPrompt) return;
    deferredPrompt.prompt();
    const { outcome } = await deferredPrompt.userChoice;
    deferredPrompt = null;
    hideInstallModal(outcome === 'accepted');
    // If they accepted, also subscribe to push
    if (outcome === 'accepted') await requestAndSubscribe();
  };

  // Dismiss button handler (snooze 30 mins)
  window.pwaInstallDismiss = function () {
    hideInstallModal(false);
  };

  // Check every 30 mins if tab stays open
  setInterval(() => maybeShowInstallModal(), INSTALL_INTERVAL_MS);

  // On load: if already installed → subscribe silently; if not → show custom notification modal
  if (isStandalone()) {
    // Already installed — ensure push subscription stays active
    window.addEventListener('load', () => {
      requestAndSubscribe();
    });
  } else {
    window.addEventListener('load', () => {
      if (Notification.permission === 'granted') {
        // Already allowed — just sync subscription to server
        subscribeToPush();
      } else if (Notification.permission === 'default') {
        // Show our persuasion modal instead of throwing the native prompt directly
        setTimeout(maybeShowNotifModal, 1500);
      }
      // denied → nothing we can do, don't nag
    });
  }
})();
