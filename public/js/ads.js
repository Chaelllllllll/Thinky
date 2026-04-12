// public/js/ads.js - shared AdSense helpers for Thinky pages

window.adsConfig = window.adsConfig || {
    clientId: 'ca-pub-2635010933890624',
    interstitialSlot: '2516960734',
    displaySlot: '2516960734'
};

let adModal = null;
let adResolve = null;
let pendingOnClose = null;

function _getAdModal() {
    if (!adModal) adModal = document.getElementById('adModal');
    return adModal;
}

function _pushAdUnit(insEl) {
    if (!insEl || insEl.dataset.adInit === '1') return;
    if (typeof window.adsbygoogle === 'undefined') return;
    try {
        (window.adsbygoogle = window.adsbygoogle || []).push({});
        insEl.dataset.adInit = '1';
    } catch (err) {
        console.warn('AdSense push failed:', err);
    }
}

// Push any ad units currently present in the document.
function initExistingAds(root = document) {
    const adUnits = root.querySelectorAll('ins.adsbygoogle:not([data-ad-init])');
    adUnits.forEach((unit, idx) => {
        setTimeout(() => _pushAdUnit(unit), idx * 120);
    });
}

function _renderModalAd(slotId) {
    const modal = _getAdModal();
    if (!modal) return null;
    const slotWrap = modal.querySelector('.ad-slot');
    if (!slotWrap) return null;

    slotWrap.innerHTML = [
        '<ins class="adsbygoogle"',
        'style="display:block"',
        `data-ad-client="${window.adsConfig.clientId}"`,
        `data-ad-slot="${slotId}"`,
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

    if (adUnit) {
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
    if (typeof window.adsbygoogle !== 'undefined') {
        initExistingAds(document);
    } else {
        // Retry after full page load in case AdSense script is still loading.
        window.addEventListener('load', () => initExistingAds(document), { once: true });
    }
});

window.initExistingAds = initExistingAds;
window.showAdModal = showAdModal;
window.closeAdModal = closeAdModal;
window.showAdThenProceed = showAdThenProceed;
