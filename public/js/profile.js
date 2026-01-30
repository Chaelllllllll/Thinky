document.addEventListener('DOMContentLoaded', async () => {
    try {
        const resp = await fetch('/api/auth/me', { credentials: 'include' });
        if (!resp.ok) return window.location.href = '/login';
        const { user } = await resp.json();

        document.getElementById('profileName').textContent = user.display_name || user.username;
        document.getElementById('profileUsername').textContent = `@${user.username}`;
            const img = document.getElementById('profileAvatar');
            const placeholder = document.getElementById('profileAvatarPlaceholder');
            if (img) {
                img.src = user.profile_picture_url || '/images/default-avatar.svg';
                img.style.display = 'block';
                if (placeholder) placeholder.style.display = 'none';
            }

        // Load user's public reviewers
        const rresp = await fetch(`/api/reviewers/public?student=${user.id}`, { credentials: 'include' });
        if (!rresp.ok) return;
        const rdata = await rresp.json();
        const reviewers = (rdata.reviewers || []).map(rv => {
            // Normalize user object (API may return `users` or `user`)
            const userObj = rv.users || rv.user || null;
            return Object.assign({}, rv, { _displayUser: userObj });
        });
        const container = document.getElementById('myReviewers');
        if (reviewers.length === 0) {
            container.innerHTML = '<div class="empty-state" style="padding:20px;">No public reviewers yet.</div>';
            return;
        }

        container.innerHTML = reviewers.map(rv => {
            const u = rv._displayUser;
            const avatar = (u && u.profile_picture_url) ? u.profile_picture_url : '/images/default-avatar.svg';
            const userHtml = u ? `<img src="${avatar}" onerror="this.onerror=null;this.src='/images/default-avatar.svg'" alt="avatar" style="width:40px;height:40px;border-radius:999px;object-fit:cover">` : '<i class="bi bi-person-circle" style="font-size:1.5rem;color:var(--primary-pink)"></i>';
            return `
            <div class="reviewer-card" data-rid="${rv.id}">
                <div style="display:flex;align-items:center;gap:12px;margin-bottom:8px;">
                    ${userHtml}
                    <div>
                        <div style="font-weight:600;">${escapeHtml(rv.title)}</div>
                        <div style="font-size:0.85rem;color:var(--dark-gray);">${escapeHtml(rv.subjects?.name || '')}</div>
                    </div>
                </div>
                <div style="color:var(--dark-gray);font-size:0.9rem;">${escapeHtml(stripHtml(rv.content).substring(0,160))}...</div>
            </div>`;
        }).join('');

        // Wire click handlers to open reviewer modal instead of redirecting
        container.querySelectorAll('.reviewer-card').forEach(el => {
            el.addEventListener('click', () => {
                const rid = el.getAttribute('data-rid');
                if (!rid) return;
                const rvObj = reviewers.find(r => String(r.id) === String(rid));
                if (rvObj) openReviewerModal(rvObj);
            });
        });

    } catch (e) {
        console.error('Failed to load profile or reviewers', e);
        window.location.href = '/login';
    }
});

function stripHtml(html) {
    const tmp = document.createElement('div');
    tmp.innerHTML = html;
    return tmp.textContent || tmp.innerText || '';
}

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

// Create and show reviewer modal (simple version used on profile page)
function openReviewerModal(rv) {
    if (!rv) return;
    let modal = document.getElementById('reviewerModal');
    if (!modal) {
        modal = document.createElement('div');
        modal.id = 'reviewerModal';
        modal.className = 'modal';
        modal.innerHTML = `
            <div class="modal-content">
                <div class="modal-header" style="display:flex;align-items:center;justify-content:space-between;gap:12px;">
                    <div style="display:flex;align-items:center;gap:12px;">
                        <h3 class="modal-title" id="modalTitle" style="margin:0;"></h3>
                    </div>
                    <div style="display:flex;align-items:center;gap:12px;">
                        <div id="modalDate" style="color:var(--dark-gray);font-size:0.95rem;margin-right:12px;"></div>
                        <button class="modal-close" onclick="closeReviewerModal()">&times;</button>
                    </div>
                </div>
                <div class="modal-body">
                    <div class="reviewer-meta mb-3" id="modalMeta"></div>
                    <div id="modalContent" style="line-height:1.8;"></div>
                    <div id="modalFlashcard" style="margin-top:16px;"></div>
                </div>
                <div class="modal-footer custom-footer">
                    <div>
                        <button id="modalHeartBtn" class="heart-btn" title="React">
                            <i id="modalHeartIcon" class="bi bi-heart"></i>
                            <span id="modalHeartCount" style="font-weight:600;margin-left:6px;">0</span>
                        </button>
                    </div>
                    <div class="right-actions">
                        <button class="btn btn-outline" id="savePdfBtn" onclick="saveAsPdf()">Save as PDF</button>
                        <button class="btn btn-light" onclick="openFlashcardsForModal()">Open Flashcards</button>
                        <button class="btn btn-light" onclick="closeReviewerModal()">Close</button>
                    </div>
                </div>
            </div>`;
        document.body.appendChild(modal);
        modal.addEventListener('click', (e) => { if (e.target.id === 'reviewerModal') closeReviewerModal(); });
    }

    const titleEl = modal.querySelector('#modalTitle');
    const dateEl = modal.querySelector('#modalDate');
    const metaEl = modal.querySelector('#modalMeta');
    const contentEl = modal.querySelector('#modalContent');

    if (titleEl) titleEl.textContent = rv.title || 'Reviewer';
    if (dateEl) dateEl.innerHTML = rv.created_at ? `<i class="bi bi-calendar"></i> <span>${new Date(rv.created_at).toLocaleDateString()}</span>` : '';
    if (metaEl) {
        const u = rv._displayUser || rv.users || rv.user || null;
        const userName = (u && u.username) ? u.username : (rv.user_id ? 'User' : '');
        const avatar = (u && u.profile_picture_url) ? u.profile_picture_url : '/images/default-avatar.svg';
        const subject = rv.subjects && rv.subjects.name ? rv.subjects.name : '';
        metaEl.innerHTML = `
            <div style="display:flex;align-items:center;gap:12px;">
                <img src="${avatar}" onerror="this.onerror=null;this.src='/images/default-avatar.svg'" style="width:40px;height:40px;border-radius:999px;object-fit:cover;">
                <div>
                    <div style="font-weight:600;">${escapeHtml(userName)}</div>
                    <div style="font-size:0.85rem;color:var(--dark-gray);">${escapeHtml(subject)}</div>
                </div>
            </div>`;
    }
    if (contentEl) contentEl.innerHTML = rv.content || '';

    modal.classList.add('show');
    modal.dataset.currentReviewerId = rv.id || '';

    // load reaction state
    (async () => {
        try {
            const r = await fetch(`/api/reviewers/${rv.id}/reactions`, { credentials: 'include' });
            let d = null;
            try { d = await r.json(); } catch (e) { d = null; }
            const cnt = (d && typeof d.count !== 'undefined') ? d.count : 0;
            const reacted = !!(d && d.reacted);
            const cntEl = modal.querySelector('#modalHeartCount');
            const icon = modal.querySelector('#modalHeartIcon');
            const btn = modal.querySelector('#modalHeartBtn');
            if (cntEl) cntEl.textContent = Number(cnt) || 0;
            if (icon) icon.className = reacted ? 'bi bi-heart-fill' : 'bi bi-heart';
            if (btn) {
                btn.classList.toggle('hearted', reacted);
                btn.onclick = async (ev) => {
                    ev.preventDefault();
                    ev.stopPropagation();
                    try {
                        const resp = await fetch(`/api/reviewers/${rv.id}/reactions`, {
                            method: 'POST',
                            credentials: 'include',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ reaction: 'heart' })
                        });
                        let data = null;
                        try { data = await resp.json(); } catch (e) { data = null; }
                        const cntEl2 = modal.querySelector('#modalHeartCount');
                        const icon2 = modal.querySelector('#modalHeartIcon');
                        if (!resp.ok) {
                            if (resp.status === 401) {
                                window.showAlert && window.showAlert('error', 'Please log in to react', 3000);
                                return;
                            } else if (resp.status === 403) {
                                window.showAlert && window.showAlert('error', 'You cannot react to your own reviewer', 3000);
                                if (data && typeof data.count !== 'undefined') {
                                    if (cntEl2) cntEl2.textContent = Number(data.count) || 0;
                                    if (icon2) icon2.className = data.reacted ? 'bi bi-heart-fill' : 'bi bi-heart';
                                    btn.classList.toggle('hearted', !!data.reacted);
                                }
                                return;
                            }
                        }
                        if (data && typeof data.count !== 'undefined') {
                            if (cntEl2) cntEl2.textContent = Number(data.count) || 0;
                            if (icon2) icon2.className = data.reacted ? 'bi bi-heart-fill' : 'bi bi-heart';
                            btn.classList.toggle('hearted', !!data.reacted);
                        } else {
                            const current = Number(cntEl2?.textContent || 0) || 0;
                            const willReact = !btn.classList.contains('hearted');
                            if (cntEl2) cntEl2.textContent = willReact ? current + 1 : Math.max(0, current - 1);
                            btn.classList.toggle('hearted', willReact);
                            if (icon2) icon2.className = willReact ? 'bi bi-heart-fill' : 'bi bi-heart';
                        }
                    } catch (e) {
                        console.error('Reaction error', e);
                    }
                };
            }
        } catch (e) { console.warn('Failed to load reactions', e); }
    })();
}

function closeReviewerModal() {
    const m = document.getElementById('reviewerModal');
    if (m) m.classList.remove('show');
}

// Provide a safe fallback for `saveAsPdf` when not available on this page
if (typeof window.saveAsPdf !== 'function') {
    window.saveAsPdf = function() {
        if (typeof showAlert === 'function') {
            showAlert('info', 'Save as PDF is not available here.');
        } else {
            alert('Save as PDF is not available here.');
        }
    };
}
