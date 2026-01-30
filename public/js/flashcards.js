// Shared flashcard viewer: one-by-one modal with next/prev and flip
(function(){
    function createModal() {
        let m = document.getElementById('flashcardViewerModal');
        if (m) return m;
        m = document.createElement('div');
        m.id = 'flashcardViewerModal';
        m.className = 'modal';
        m.innerHTML = `
            <div class="modal-content">
                <div class="modal-header">
                    <h3 class="modal-title" id="fcViewerTitle">Flashcards</h3>
                    <button class="modal-close" onclick="closeFlashcardViewer()">&times;</button>
                </div>
                <div class="modal-body">
                    <div id="fcViewerCard"></div>
                </div>
                <div class="modal-footer">
                    <div style="display:flex;align-items:center;gap:8px;">
                        <button id="fcPrevBtn" class="btn btn-light">Prev</button>
                        <button id="fcFlipBtn" class="btn btn-outline">Flip</button>
                        <button id="fcNextBtn" class="btn btn-light">Next</button>
                    </div>
                    <div style="margin-left:auto;">
                        <button class="btn btn-light" onclick="closeFlashcardViewer()">Close</button>
                    </div>
                </div>
            </div>`;
        document.body.appendChild(m);
        m.addEventListener('click', (e) => { if (e.target.id === 'flashcardViewerModal') closeFlashcardViewer(); });
        return m;
    }

    function renderCard(container, fc, showBack, idx = 0, total = 0) {
        container.innerHTML = '';
        const el = document.createElement('div');
        el.className = 'flashcard';
        el.style.position = 'relative';
        el.style.width = '100%';
        el.style.height = '100%';
        if (showBack) el.classList.add('flipped');
        el.tabIndex = 0;
        const inner = document.createElement('div'); inner.className = 'flashcard-inner';
        const front = document.createElement('div'); front.className = 'flashcard-face flashcard-front';
        front.innerHTML = `<div class="flashcard-text">${escapeHtml(String(fc.front || ''))}</div>`;
        const back = document.createElement('div'); back.className = 'flashcard-face flashcard-back';
        back.innerHTML = `<div class="flashcard-text">${escapeHtml(String(stripHtml(fc.back || '')).substring(0,1000))}</div>`;
        // generate a light random pastel background color for this card
        try {
            const h = Math.floor(Math.random() * 360);
            const c1 = `hsl(${h} 70% 95%)`;
            const c2 = `hsl(${h} 70% 90%)`;
            front.style.background = `linear-gradient(180deg, ${c1}, ${c2})`;
            back.style.background = `linear-gradient(180deg, ${c2}, ${c1})`;
        } catch (e) {}
        inner.appendChild(front); inner.appendChild(back); el.appendChild(inner);
        // counter at bottom of the flashcard
        const counter = document.createElement('div');
        counter.className = 'flashcard-counter';
        counter.textContent = total > 0 ? `Card ${idx+1} of ${total}` : '';
        el.appendChild(counter);
        // toggle
        const toggle = () => el.classList.toggle('flipped');
        el.addEventListener('click', toggle);
        el.addEventListener('keydown', (ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); toggle(); } });
        container.appendChild(el);
    }

    window.openFlashcardViewer = function(flashcards, startIndex = 0) {
        if (!Array.isArray(flashcards) || flashcards.length === 0) return;
        const modal = createModal();
        const cardWrap = modal.querySelector('#fcViewerCard');
        const prev = modal.querySelector('#fcPrevBtn');
        const next = modal.querySelector('#fcNextBtn');
        const flip = modal.querySelector('#fcFlipBtn');

        let idx = Math.max(0, Math.min(startIndex || 0, flashcards.length - 1));
        let showBack = false;

        function refresh() {
            const fc = flashcards[idx];
            if (!fc) return;
            renderCard(cardWrap, { front: fc.front || fc.meaning || '', back: fc.back || fc.content || '' }, showBack, idx, flashcards.length);
            // focus for keyboard handling
            cardWrap.querySelector('.flashcard')?.focus();
        }

        prev.onclick = (e) => { e.preventDefault(); idx = (idx - 1 + flashcards.length) % flashcards.length; showBack = false; refresh(); };
        next.onclick = (e) => { e.preventDefault(); idx = (idx + 1) % flashcards.length; showBack = false; refresh(); };
        flip.onclick = (e) => { e.preventDefault(); showBack = !showBack; refresh(); };

        // keyboard navigation
        function onKey(e) {
            if (!document.getElementById('flashcardViewerModal')) return;
            if (e.key === 'ArrowLeft') prev.click();
            else if (e.key === 'ArrowRight') next.click();
            else if (e.key === 'Escape') closeFlashcardViewer();
            else if (e.key === ' ') { e.preventDefault(); flip.click(); }
        }

        document.addEventListener('keydown', onKey);

        // attach cleanup on close
        function closeHandler() {
            document.removeEventListener('keydown', onKey);
            modal.classList.remove('show');
            // slight delay to keep DOM if other pages rely on it
        }

        // expose close globally for onclick handlers
        window.closeFlashcardViewer = closeHandler;

        modal.classList.add('show');
        refresh();
    };

    // Helper that reads common modal dataset to find reviewer id, fetch reviewer, and open viewer
    window.openFlashcardsForModal = async function() {
        // Look for common modals carrying a currentReviewerId
        const candidates = ['viewReviewerModal','reviewerModal'];
        let rid = null;
        for (const id of candidates) {
            const el = document.getElementById(id);
            if (el && el.dataset && el.dataset.currentReviewerId) { rid = el.dataset.currentReviewerId; break; }
        }
        if (!rid) return;
        try {
            const resp = await fetch(`/api/reviewers/${rid}`, { credentials: 'include' });
            if (!resp.ok) return;
            const data = await resp.json();
            const reviewer = data.reviewer || data;
            const fcs = Array.isArray(reviewer.flashcards) ? reviewer.flashcards : [];
            if (!fcs || fcs.length === 0) {
                if (typeof showAlert === 'function') {
                    showAlert('info', 'No flashcards have been posted for this reviewer.');
                } else {
                    alert('No flashcards have been posted for this reviewer.');
                }
                return;
            }
            window.openFlashcardViewer(fcs);
        } catch (e) { console.warn('Open flashcards failed', e); }
    };

    // small utilities duplicated to avoid cross-file assumptions
    function stripHtml(html) { const tmp = document.createElement('div'); tmp.innerHTML = html || ''; return tmp.textContent || tmp.innerText || ''; }
    function escapeHtml(text) { const div = document.createElement('div'); div.textContent = text || ''; return div.innerHTML; }

})();
