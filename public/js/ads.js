// public/js/ads.js - AdSense integration for Thinky
// Note: Replace AD_SLOT_INTERSTITIAL and AD_SLOT_DISPLAY with your actual AdSense slot IDs

window.adsConfig = {
    clientId: 'ca-pub-2635010933890624',
    interstitialSlot: '2516960734', // e.g. '1234567890'
    displaySlot: '2516960734' // e.g. '0987654321'
};

let adModal = null;
let adResolve = null;
let currentAdSlot = null;

// Initialize AdSense push for existing ads
function initExistingAds() {
    if (typeof adsbygoogle !== 'undefined') {
        (adsbygoogle = window.adsbygoogle || []).push({});
    }
}

// Show ad modal (display ad unit)
function showAdModal(slotId, onClose) {
    if (!adModal) {
        adModal = document.getElementById('adModal');
        if (!adModal) return false;
    }
    
    currentAdSlot = slotId;
    adModal.classList.add('show');
    adModal.querySelector('.ad-slot').dataset.adSlot = slotId;
    
    // Load/push new ad
    setTimeout(() => {
        if (typeof adsbygoogle !== 'undefined') {
            (adsbygoogle = window.adsbygoogle || []).push({});
        }
    }, 500);
    
    // Setup close handler
    adModal.onclick = (e) => {
        if (e.target === adModal) {
            closeAdModal(onClose);
        }
    };
    
    return true;
}

function closeAdModal(callback) {
    if (adModal) {
        adModal.classList.remove('show');
        adModal.onclick = null;
    }
    if (callback) callback();
    adResolve?.();
    adResolve = null;
}

// Promise-based: Show ad, resolve when closed
function showAdThenProceed(callback, slotId = window.adsConfig.displaySlot) {
    return new Promise((resolve) => {
        adResolve = resolve;
        if (!showAdModal(slotId, () => {
            setTimeout(callback, 500); // Delay navigation
            resolve();
        })) {
            // Fallback: no ad, proceed immediately
            setTimeout(callback, 100);
            resolve();
        }
    });
}

// Intercept card clicks for ads
function initCardAds() {
    document.addEventListener('click', async (e) => {
        const card = e.target.closest('.reviewer-card');
        if (!card || e.target.closest('.card-heart-btn, .share-subject-btn')) return;
        
        e.preventDefault();
        e.stopPropagation();
        
        const rect = card.getBoundingClientRect();
        const isSubjectCard = card.dataset.subjectId && !card.querySelector('.card-heart-btn');
        
        if (isSubjectCard) {
            // Subject card: get subject data and proceed
            const subjectId = card.dataset.subjectId;
            const subjectName = card.dataset.subjectName || 'Subject';
            await showAdThenProceed(() => selectSubject(subjectId, subjectName));
        } else {
            // Reviewer card: get reviewer data from existing displayReviewers logic
            // Find reviewer data (hack: from title or add data-reviewer-id if needed)
            const titleEl = card.querySelector('.reviewer-title');
            if (!titleEl) return;
            
            // For now, just delay navigation - update when reviewer data structured
            await showAdThenProceed(() => {
                // Extract reviewer ID if available or simulate navigation
                const reviewerId = card.dataset.reviewerId || 'demo';
                window.location.href = `/reviewer.html?id=${reviewerId}`;
            });
        }
    });
}

// Init on DOM ready
document.addEventListener('DOMContentLoaded', () => {
    initExistingAds();
    initCardAds();
});

// Export for index.html
window.showAdThenProceed = showAdThenProceed;
window.initCardAds = initCardAds;
