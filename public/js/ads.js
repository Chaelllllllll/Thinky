// public/js/ads.js - shared AdSense + MBID helpers for Thinky pages

window.adsConfig = window.adsConfig || {
    clientId: 'ca-pub-2635010933890624',
    interstitialSlot: '2516960734',
    displaySlot: '2516960734',
    mbidPublisherId: '440759',
    mbidInlineBannerId: '2021348',
    mbidSecondaryBannerId: '2021349'
};

let adModal = null;
let adResolve = null;
let pendingOnClose = null;
let adObserver = null;

function ensureMbidScript() {
    const pid = window.adsConfig && window.adsConfig.mbidPublisherId;
    if (!pid) return;
    if (document.querySelector('script[data-thinky-mbid="1"]')) return;
    if (document.querySelector('script[src*="js.mbidadm.com/static/scripts.js"]')) return;
    const s = document.createElement('script');
    s.async = true;
    s.src = 'https://js.mbidadm.com/static/scripts.js';
    s.setAttribute('data-admpid', String(pid));
    s.setAttribute('data-thinky-mbid', '1');
    document.head.appendChild(s);
}

function _getAdModal() {
    if (!adModal) adModal = document.getElementById('adModal');
    return adModal;
}

function _pushAdUnit(insEl) {
    if (!insEl) return;
    const st = insEl.dataset.adInit;
    if (st === '1' || st === 'error') return;
    if (typeof window.adsbygoogle === 'undefined') {
        delete insEl.dataset.adInit;
        return;
    }
    try {
        (window.adsbygoogle = window.adsbygoogle || []).push({});
        insEl.dataset.adInit = '1';
    } catch (err) {
        // Mark done so scheduleAdInit / MutationObserver retries do not call push again
        // (avoids "All ins elements ... already have ads" from duplicate pushes).
        insEl.dataset.adInit = 'error';
        const msg = err && err.message ? err.message : String(err);
        if (!msg.includes('already have ads')) {
            console.warn('AdSense push failed:', err);
        }
    }
}

// Push any ad units currently present in the document.
function initExistingAds(root = document) {
    const adUnits = root.querySelectorAll('ins.adsbygoogle:not([data-ad-init])');
    adUnits.forEach((unit, idx) => {
        if (unit.dataset.adInit) return;
        unit.dataset.adInit = 'pending';
        setTimeout(() => _pushAdUnit(unit), idx * 120);
    });
}

function scheduleAdInit(root = document) {
    const run = () => initExistingAds(root);
    if (typeof window.requestIdleCallback === 'function') {
        window.requestIdleCallback(run, { timeout: 1000 });
    } else {
        setTimeout(run, 100);
    }
}

function observeAdSlots(root = document) {
    if (adObserver || typeof MutationObserver === 'undefined') return;
    const target = root.documentElement || root;
    adObserver = new MutationObserver((mutations) => {
        for (const mutation of mutations) {
            for (const node of mutation.addedNodes || []) {
                if (!node || node.nodeType !== 1) continue;
                if (node.matches && node.matches('ins.adsbygoogle')) {
                    scheduleAdInit(node.parentNode || document);
                    continue;
                }
                if (node.querySelector && node.querySelector('ins.adsbygoogle')) {
                    scheduleAdInit(node);
                }
            }
        }
    });
    adObserver.observe(target, { childList: true, subtree: true });
}

function _renderModalAd(slotId) {
    const modal = _getAdModal();
    if (!modal) return null;
    const slotWrap = modal.querySelector('.ad-slot');
    if (!slotWrap) return null;

    const mbidSecondary = window.adsConfig && window.adsConfig.mbidSecondaryBannerId;
    if (mbidSecondary) {
        ensureMbidScript();
        slotWrap.innerHTML =
            '<div class="thinky-mbid-interstitial" data-banner-id="' +
            String(mbidSecondary).replace(/[^0-9]/g, '') +
            '"></div>';
        return slotWrap.querySelector('[data-banner-id]');
    }

    slotWrap.innerHTML = [
        '<ins class="adsbygoogle"',
        'style="display:block"',
        `data-ad-client="${window.adsConfig.clientId}"`,
        `data-ad-slot="${slotId || window.adsConfig.interstitialSlot || window.adsConfig.displaySlot}"`,
        'data-ad-format="auto"',
        'data-full-width-responsive="true"></ins>'
    ].join(' ');

    return slotWrap.querySelector('ins.adsbygoogle');
}

// Show ad modal and wait for user close.
function showAdModal(slotId, onClose) {
    const modal = _getAdModal();
    if (!modal) return false;

    pendingOnClose = typeof onClose === 'function' ? onClose : null;
    const adUnit = _renderModalAd(slotId || window.adsConfig.interstitialSlot);

    modal.style.display = 'flex';
    modal.setAttribute('aria-hidden', 'false');
    modal.onclick = (e) => {
        if (e.target === modal) closeAdModal();
    };

    if (adUnit && adUnit.matches && adUnit.matches('ins.adsbygoogle')) {
        setTimeout(() => _pushAdUnit(adUnit), 220);
    }

    return true;
}

function closeAdModal(callback) {
    const modal = _getAdModal();
    if (modal) {
        modal.style.display = 'none';
        modal.setAttribute('aria-hidden', 'true');
        modal.onclick = null;
    }

    const onClose = typeof callback === 'function' ? callback : pendingOnClose;
    pendingOnClose = null;
    if (typeof onClose === 'function') onClose();

    if (typeof adResolve === 'function') adResolve();
    adResolve = null;
}

// Promise-based helper for actions that should run after an interstitial ad.
function showAdThenProceed(callback, slotId = window.adsConfig.interstitialSlot || window.adsConfig.displaySlot) {
    return new Promise((resolve) => {
        adResolve = resolve;
        if (!showAdModal(slotId, () => {
            setTimeout(() => {
                if (typeof callback === 'function') callback();
            }, 180);
        })) {
            setTimeout(() => {
                if (typeof callback === 'function') callback();
                resolve();
            }, 80);
        }
    });
}

document.addEventListener('DOMContentLoaded', () => {
    ensureMbidScript();
    observeAdSlots(document);
    scheduleAdInit(document);
    // Retry after full page load in case AdSense script is still loading.
    window.addEventListener('load', () => {
        scheduleAdInit(document);
        try {
            window.dispatchEvent(new Event('resize'));
        } catch (_) {}
    }, { once: true });
});

window.initExistingAds = initExistingAds;
window.scheduleAdInit = scheduleAdInit;
window.observeAdSlots = observeAdSlots;
window.showAdModal = showAdModal;
window.closeAdModal = closeAdModal;
window.showAdThenProceed = showAdThenProceed;
window.ensureMbidScript = ensureMbidScript;
