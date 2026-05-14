// Track user ids for follow list modal (set inside DOMContentLoaded)
window._flFollowListUserId = null;
window._flLoggedInId = null;

document.addEventListener('DOMContentLoaded', async () => {
    try {
        const resp = await fetch('/api/auth/me', { credentials: 'include' });
        if (!resp.ok) return window.location.href = '/login';
        const { user } = await resp.json();

        const profileNameText = document.getElementById('profileNameText');
        const profileVerifiedBadge = document.getElementById('profileVerifiedBadge');
        
        profileNameText.textContent = user.display_name || user.username;
        document.getElementById('profileUsername').textContent = `@${user.username}`;
        
        // Show verified badge for admin users
        if (user.role === 'admin') {
            profileVerifiedBadge.style.display = 'inline-block';
        }
        
        // Store user id for follow list modal (profile page: logged-in user IS the profile user)
        window._flFollowListUserId = user.id;
        window._flLoggedInId = user.id;
        
        // Display follower counts
        const followerCountEl = document.getElementById('followerCount');
        const followingCountEl = document.getElementById('followingCount');
        if (followerCountEl) followerCountEl.textContent = formatCount(user.follower_count || 0);
        if (followingCountEl) followingCountEl.textContent = formatCount(user.following_count || 0);
        
            const img = document.getElementById('profileAvatar');
            const placeholder = document.getElementById('profileAvatarPlaceholder');
            if (img) {
                img.src = user.profile_picture_url || '/images/default-avatar.svg';
                img.style.display = 'block';
                if (placeholder) placeholder.style.display = 'none';
            }

        // Load user's posts and render them (profile page shows posts)
        const container = document.getElementById('myReviewers');
        const searchInput = document.getElementById('profileSearch');
        let posts = [];

        async function loadProfilePosts() {
            try {
                const resp = await fetch(`/api/posts?user=${encodeURIComponent(user.id)}&limit=50`, { credentials: 'include' });
                if (!resp.ok) throw new Error('Failed to load posts');
                const data = await resp.json();
                posts = data.posts || data.items || [];
                renderPosts();
            } catch (e) {
                console.error('Failed to load posts', e);
                if (container) container.innerHTML = '<div class="empty-state" style="padding:20px;color:var(--dark-gray);">Failed to load posts</div>';
            }
        }

        function makePostCard(post) {
            const d = document.createElement('div');
            d.className = 'reviewer-card';
            const title = escapeHtml(post.title || 'Untitled');
            const preview = escapeHtml(stripHtml(post.content || '').substring(0, 220));
            const author = escapeHtml(post.users?.username || post.users?.display_name || '');
            const date = post.created_at ? new Date(post.created_at).toLocaleDateString() : '';
            d.innerHTML = `
                <div style="display:flex;flex-direction:column;gap:8px;">
                    <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;">
                        <div style="min-width:0;">
                            <div style="font-weight:700;font-size:1.05rem;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${title}</div>
                            <div style="font-size:0.85rem;color:var(--dark-gray);">by ${author} · ${date}</div>
                        </div>
                        <div style="flex-shrink:0;display:flex;gap:8px;align-items:center;">
                            <button class="btn btn-sm btn-light" onclick="event.stopPropagation(); window.location.href='/post.html?id=${encodeURIComponent(post.id)}';">View</button>
                        </div>
                    </div>
                    <div style="color:var(--text-dark);line-height:1.6;">${preview}${(preview.length? '...' : '')}</div>
                </div>
            `;
            d.addEventListener('click', () => { window.location.href = `/post.html?id=${encodeURIComponent(post.id)}`; });
            return d;
        }

        function renderPosts(filter = '') {
            if (!container) return;
            const term = (filter || '').toLowerCase().trim();
            const list = term ? posts.filter(p => ((p.title||'') + ' ' + (stripHtml(p.content)||'')).toLowerCase().includes(term)) : posts;
            if (!list || list.length === 0) {
                container.innerHTML = '<div class="empty-state" style="padding:20px;color:var(--dark-gray);">No posts yet.</div>';
                return;
            }
            container.innerHTML = '';
            list.forEach(p => container.appendChild(makePostCard(p)));
        }

        // Wire search
        if (searchInput) searchInput.addEventListener('input', debounce((e) => renderPosts(e.target.value), 300));

        // initial load posts
        await loadProfilePosts();

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

// ── Followers / Following Modal (with lazy loading) ───────────────────────────
const _flState = { type: null, offset: 0, limit: 20, loading: false, finished: false };

function openFollowListModal(type) {
    const targetId = window._flFollowListUserId;
    if (!targetId) return;
    const modal = document.getElementById('followListModal');
    if (!modal) return;

    // Reset paging state
    _flState.type = type;
    _flState.offset = 0;
    _flState.loading = false;
    _flState.finished = false;

    document.getElementById('followListTitle').textContent = type === 'followers' ? 'Followers' : 'Following';
    const body = document.getElementById('followListBody');
    body.innerHTML = '';
    modal.classList.add('show');
    document.body.style.overflow = 'hidden';

    // Wire scroll-based lazy loading on the modal body
    body.onscroll = () => {
        if (_flState.loading || _flState.finished) return;
        if (body.scrollTop + body.clientHeight >= body.scrollHeight - 60) {
            _flLoadFollowPage();
        }
    };

    _flLoadFollowPage(true);
}

async function _flLoadFollowPage(first = false) {
    const targetId = window._flFollowListUserId;
    if (!targetId || _flState.loading || _flState.finished) return;
    _flState.loading = true;

    const body = document.getElementById('followListBody');
    if (!body) { _flState.loading = false; return; }

    // Show spinner at bottom (or replace initial loading text)
    let spinner = body.querySelector('._fl-spinner');
    if (!spinner) {
        spinner = document.createElement('div');
        spinner.className = '_fl-spinner';
        spinner.style.cssText = 'text-align:center;padding:16px;color:var(--dark-gray);font-size:0.9rem;';
        spinner.textContent = 'Loading...';
        body.appendChild(spinner);
    }

    try {
        const params = new URLSearchParams({ limit: _flState.limit, offset: _flState.offset });
        const resp = await fetch(`/api/users/${encodeURIComponent(targetId)}/${_flState.type}?${params}`, { credentials: 'include' });
        const { users = [], hasMore = false } = resp.ok ? await resp.json() : {};

        spinner.remove();

        if (first && users.length === 0) {
            body.innerHTML = `<div style="text-align:center;padding:24px;color:var(--dark-gray);">No ${_flState.type === 'followers' ? 'followers' : 'following'} yet</div>`;
            _flState.finished = true;
            return;
        }

        users.forEach(u => body.appendChild(_makeFollowListRow(u)));
        _flState.offset += users.length;
        _flState.finished = !hasMore;
    } catch (e) {
        if (spinner) spinner.remove();
        if (first) body.innerHTML = '<div style="text-align:center;padding:24px;color:var(--dark-gray);">Failed to load</div>';
    } finally {
        _flState.loading = false;
    }
}

function closeFollowListModal() {
    const modal = document.getElementById('followListModal');
    if (modal) modal.classList.remove('show');
    document.body.style.overflow = '';
}

function _makeFollowListRow(u) {
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;align-items:center;gap:12px;padding:10px 20px;border-bottom:1px solid var(--light-gray);';
    const isMe = window._flLoggedInId && String(window._flLoggedInId) === String(u.id);
    const btnHtml = (!isMe && window._flLoggedInId)
        ? `<button class="btn btn-sm ${u.is_following ? 'btn-outline' : 'btn-primary'}" style="margin-left:auto;flex-shrink:0;min-width:80px;" data-following="${u.is_following ? '1' : '0'}" onclick="toggleFollowInModal(this,'${escapeHtml(String(u.id))}')">${u.is_following ? 'Unfollow' : 'Follow'}</button>`
        : '';
    const verifiedBadge = (u.role === 'admin' || u.is_admin) ? '<i class="bi bi-check-circle-fill" style="font-size:0.65rem;margin-left:4px;color:var(--primary-pink);vertical-align:middle;" title="Verified Admin"></i>' : '';
    row.innerHTML = `
        <a href="/user.html?user=${escapeHtml(String(u.id))}" style="display:flex;align-items:center;gap:12px;text-decoration:none;color:inherit;flex:1;min-width:0;">
            <img src="${escapeHtml(u.profile_picture_url || '/images/default-avatar.svg')}" onerror="this.onerror=null;this.src='/images/default-avatar.svg'" style="width:42px;height:42px;border-radius:50%;object-fit:cover;flex-shrink:0;">
            <div style="min-width:0;">
                <div style="font-weight:600;font-size:0.95rem;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;display:flex;align-items:center;gap:4px;">${escapeHtml(u.display_name || u.username)}${verifiedBadge}</div>
                <div style="font-size:0.8rem;color:var(--dark-gray);">@${escapeHtml(u.username)}</div>
            </div>
        </a>
        ${btnHtml}`;
    return row;
}
    return row;
}

async function toggleFollowInModal(btn, targetId) {
    if (!window._flLoggedInId) { window.location.href = '/login'; return; }
    const isFollowing = btn.dataset.following === '1';
    btn.disabled = true;
    try {
        const resp = await fetch(`/api/users/${encodeURIComponent(targetId)}/follow`, {
            method: isFollowing ? 'DELETE' : 'POST',
            credentials: 'include'
        });
        if (!resp.ok) {
            const d = await resp.json().catch(() => ({}));
            window.showAlert && window.showAlert('error', d.error || 'Failed');
            return;
        }
        const { following } = await resp.json();
        btn.dataset.following = following ? '1' : '0';
        btn.textContent = following ? 'Unfollow' : 'Follow';
        if (following) { btn.classList.remove('btn-primary'); btn.classList.add('btn-outline'); }
        else { btn.classList.remove('btn-outline'); btn.classList.add('btn-primary'); }
    } catch (e) {
        window.showAlert && window.showAlert('error', 'Failed to update follow status');
    } finally {
        btn.disabled = false;
    }
}

// Close follow list modal on overlay click
document.addEventListener('click', (e) => {
    const modal = document.getElementById('followListModal');
    if (modal && e.target === modal) closeFollowListModal();
});

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
