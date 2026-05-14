// public/js/ads.js — MyBid (MBID) only: loader, interstitial modal, slot helpers (no AdSense).

window.adsConfig = window.adsConfig || {
    mbidPublisherId: '440759',
    mbidInlineBannerId: '2021348',
    mbidSecondaryBannerId: '2021349'
};

let adModal = null;
let adResolve = null;
let pendingOnClose = null;
let _modalHintTimer = null;

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

function _nudgeMbid() {
    try {
        window.dispatchEvent(new Event('resize'));
    } catch (_) {}
}

function _nudgeMbidDelayedChain() {
    [0, 100, 350, 900, 2000].forEach((ms) => setTimeout(() => _nudgeMbid(), ms));
}

function _getAdModal() {
    if (!adModal) adModal = document.getElementById('adModal');
    return adModal;
}

function _mbidInnerHasCreative(inner) {
    if (!inner) return false;
    if (inner.querySelector('iframe[src], iframe[srcdoc]')) return true;
    if (inner.querySelector('canvas')) return true;
    const img = inner.querySelector('img[src]');
    if (img && img.naturalWidth > 1) return true;
    return false;
}

/**
 * Hides MBID shell when no iframe/creative appears (avoids large empty white cards).
 * Skips nodes inside #adModal (modal uses a hint instead).
 */
function wireThinkyMbidCollapseIfNeeded(rootEl) {
    if (!rootEl || rootEl.closest('#adModal')) return;
    if (rootEl.dataset.mbidCollapseArmed === '1') return;
    rootEl.dataset.mbidCollapseArmed = '1';

    const inner = rootEl.querySelector('[data-banner-id]');
    if (!inner) return;

    const markFilled = () => {
        rootEl.classList.remove('thinky-mbid--collapsed');
        rootEl.classList.add('thinky-mbid--filled');
    };

    const maybeCollapse = () => {
        if (rootEl.classList.contains('thinky-mbid--filled')) return;
        if (_mbidInnerHasCreative(inner)) {
            markFilled();
            return;
        }
        rootEl.classList.add('thinky-mbid--collapsed');
    };

    if (_mbidInnerHasCreative(inner)) {
        markFilled();
        return;
    }

    const m = new MutationObserver(() => {
        if (_mbidInnerHasCreative(inner)) {
            markFilled();
            m.disconnect();
        }
    });
    m.observe(inner, { childList: true, subtree: true });
    setTimeout(() => {
        m.disconnect();
        maybeCollapse();
    }, 3200);
}

function _renderModalAd() {
    const modal = _getAdModal();
    if (!modal) return null;
    const slotWrap = modal.querySelector('.thinky-ad-modal-slot') || modal.querySelector('.ad-slot');
    if (!slotWrap) return null;

    const ph = modal.querySelector('#adModalPlaceholder');
    const mbHost = modal.querySelector('#adModalMbidMount');
    const asHost = modal.querySelector('#adModalAdsenseMount');
    const bannerEl = modal.querySelector('#adModalMbidBanner');

    const mbidId =
        (window.adsConfig && window.adsConfig.mbidSecondaryBannerId) ||
        (window.adsConfig && window.adsConfig.mbidInlineBannerId);
    if (!mbidId) return null;

    ensureMbidScript();
    const id = String(mbidId).replace(/[^0-9]/g, '');
    if (bannerEl) bannerEl.setAttribute('data-banner-id', id);
    if (ph) ph.style.display = 'none';
    if (asHost) {
        asHost.style.display = 'none';
        asHost.innerHTML = '';
    }
    if (mbHost) mbHost.style.display = 'block';
    return bannerEl;
}

function showAdModal(_slotIdIgnored, onClose) {
    const modal = _getAdModal();
    if (!modal) return false;

    pendingOnClose = typeof onClose === 'function' ? onClose : null;
    const slot = modal.querySelector('.thinky-ad-modal-slot');
    if (slot) slot.classList.remove('thinky-mbid-modal--show-hint');
    if (_modalHintTimer) {
        clearTimeout(_modalHintTimer);
        _modalHintTimer = null;
    }

    const adUnit = _renderModalAd();

    modal.style.display = 'flex';
    modal.setAttribute('aria-hidden', 'false');
    modal.onclick = (e) => {
        if (e.target === modal) closeAdModal();
    };

    _nudgeMbidDelayedChain();

    const mbidInner = modal.querySelector('#adModalMbidBanner');
    if (mbidInner) {
        _modalHintTimer = setTimeout(() => {
            if (_mbidInnerHasCreative(mbidInner)) return;
            slot && slot.classList.add('thinky-mbid-modal--show-hint');
        }, 2400);
    }

    return !!adUnit;
}

function closeAdModal(callback) {
    const modal = _getAdModal();
    if (_modalHintTimer) {
        clearTimeout(_modalHintTimer);
        _modalHintTimer = null;
    }
    if (modal) {
        const slot = modal.querySelector('.thinky-ad-modal-slot');
        if (slot) slot.classList.remove('thinky-mbid-modal--show-hint');
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

function showAdThenProceed(callback) {
    return new Promise((resolve) => {
        adResolve = resolve;
        if (!showAdModal(null, () => {
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
    document.querySelectorAll('.thinky-mbid-collapse-root').forEach((el) => {
        if (el.closest('#adModal')) return;
        const cs = getComputedStyle(el);
        if (cs.display === 'none' || cs.visibility === 'hidden') return;
        wireThinkyMbidCollapseIfNeeded(el);
    });
    window.addEventListener('load', () => {
        _nudgeMbidDelayedChain();
    }, { once: true });
});

window.showAdModal = showAdModal;
window.closeAdModal = closeAdModal;
window.showAdThenProceed = showAdThenProceed;
window.ensureMbidScript = ensureMbidScript;
window.wireThinkyMbidCollapseIfNeeded = wireThinkyMbidCollapseIfNeeded;
window.nudgeThinkyMbid = _nudgeMbidDelayedChain;
// Back-compat no-ops (older pages)
window.initExistingAds = function () {};
window.scheduleAdInit = function () {};
window.observeAdSlots = function () {};
