(function(){
    const params = new URLSearchParams(window.location.search);
    const userId = params.get('user');
    if (!userId) {
        document.body.innerHTML = '<div style="padding:40px;">Missing user id</div>';
        return;
    }

    const avatarEl = document.getElementById('userAvatar');
    const displayNameEl = document.getElementById('userDisplayName');
    const usernameEl = document.getElementById('userUsername');
    const followerCountEl = document.getElementById('followerCount');
    const followingCountEl = document.getElementById('followingCount');
    const followBtn = document.getElementById('followBtn');
    const reviewersContainer = document.getElementById('userReviewers');
    const loadingEl = document.getElementById('userLoading');
    const loadMoreWrap = document.getElementById('userLoadMoreWrap');
    const loadMoreBtn = document.getElementById('userLoadMore');
    const searchInput = document.getElementById('userSearch');

    let offset = 0;
    const limit = 6;
    let finished = false;
    let loading = false;
    let currentQuery = '';
    let _loggedInUserId = null;
    let viewMode = 'all'; // 'all' or 'subjects'
    let selectedSubject = null;
    let allReviewersData = [];

    async function fetchUser() {
        try {
            const resp = await fetch(`/api/users/${encodeURIComponent(userId)}`);
            if (!resp.ok) throw new Error('Not found');
            const { user } = await resp.json();
            avatarEl.src = user.profile_picture_url || '/images/default-avatar.svg';
            // Render display name and Developer badge if applicable
            const displayName = user.display_name || user.username || '';
            if (user.is_dev) {
                displayNameEl.innerHTML = `${escapeHtml(displayName)} <span class="badge badge-dev" style="margin-left:8px;">Developer</span>`;
            } else {
                displayNameEl.textContent = displayName;
            }
            usernameEl.textContent = user.username;
            
            // Display follower counts
            followerCountEl.textContent = formatCount(user.follower_count || 0);
            followingCountEl.textContent = formatCount(user.following_count || 0);

            // Check if current user is logged in and load follow status
            try {
                const meResp = await fetch('/api/auth/me', { credentials: 'include' });
                if (meResp.ok) {
                    const { user: currentUser } = await meResp.json();
                    _loggedInUserId = currentUser?.id || null;
                    
                    // Show follow button only if viewing another user's profile
                    if (_loggedInUserId && String(_loggedInUserId) !== String(userId)) {
                        followBtn.style.display = 'inline-flex';
                        
                        // Check follow status
                        const followStatusResp = await fetch(`/api/users/${encodeURIComponent(userId)}/follow-status`, { credentials: 'include' });
                        if (followStatusResp.ok) {
                            const { following } = await followStatusResp.json();
                            updateFollowButton(following);
                        }
                    }
                }
            } catch (e) {
                // Not logged in, hide follow button
            }
        } catch (e) {
            console.error('Failed to load user', e);
            hidePageLoader();
            document.body.innerHTML = '<div style="padding:40px;">User not found</div>';
            return;
        }
        hidePageLoader();
    }

    function hidePageLoader() {
        const loader = document.getElementById('pageLoader');
        if (!loader) return;
        loader.classList.add('loader-hide');
        setTimeout(() => loader.remove(), 380);
    }

    function updateFollowButton(following) {
        if (following) {
            followBtn.textContent = 'Unfollow';
            followBtn.classList.remove('btn-primary');
            followBtn.classList.add('btn-outline');
        } else {
            followBtn.textContent = 'Follow';
            followBtn.classList.remove('btn-outline');
            followBtn.classList.add('btn-primary');
        }
    }

    async function toggleFollow() {
        if (!_loggedInUserId) {
            window.location.href = '/login';
            return;
        }

        const isFollowing = followBtn.textContent === 'Unfollow';
        followBtn.disabled = true;

        try {
            const method = isFollowing ? 'DELETE' : 'POST';
            const resp = await fetch(`/api/users/${encodeURIComponent(userId)}/follow`, {
                method,
                credentials: 'include'
            });

            if (!resp.ok) {
                const data = await resp.json();
                window.showAlert && window.showAlert('error', data.error || 'Failed to update follow status');
                return;
            }

            const { following } = await resp.json();
            updateFollowButton(following);
            
            // Update follower count
            const currentCount = parseInt(followerCountEl.textContent.replace(/[KMB]/i, '')) || 0;
            // Re-fetch the accurate count or approximate from displayed value
            const resp2 = await fetch(`/api/users/${encodeURIComponent(userId)}`);
            if (resp2.ok) {
                const { user: refreshed } = await resp2.json();
                followerCountEl.textContent = formatCount(refreshed.follower_count || 0);
            } else {
                followerCountEl.textContent = formatCount(following ? currentCount + 1 : Math.max(0, currentCount - 1));
            }
            
            window.showAlert && window.showAlert('success', following ? 'Successfully followed!' : 'Unfollowed', 2000);
        } catch (error) {
            console.error('Toggle follow error:', error);
            window.showAlert && window.showAlert('error', 'Failed to update follow status');
        } finally {
            followBtn.disabled = false;
        }
    }

    // Wire follow button
    if (followBtn) {
        followBtn.addEventListener('click', toggleFollow);
    }

    function makeCard(rv) {
        const d = document.createElement('div');
        d.className = 'reviewer-card';
        d.innerHTML = `
            <div class="reviewer-title">${escapeHtml(rv.title)}</div>
            <div class="reviewer-meta">
                <div class="reviewer-meta-item">
                    <a href="/user.html?user=${rv.user_id}" style="display:inline-flex;align-items:center;gap:8px;text-decoration:none;color:inherit;"><img src="${rv.users?.profile_picture_url || '/images/default-avatar.svg'}" onerror="this.onerror=null;this.src='/images/default-avatar.svg'" style="width:32px;height:32px;border-radius:999px;object-fit:cover;"> <span>${escapeHtml(rv.users?.username || '')}</span></a>
                </div>
                <div class="reviewer-meta-item"><i class="bi bi-book"></i> <span>${escapeHtml(rv.subjects?.name || '')}</span></div>
            </div>
            <div class="reviewer-preview">${escapeHtml(stripHtml(rv.content).substring(0,160))}...</div>
            <div class="card-actions">
                <button class="card-heart-btn" data-reviewer-id="${rv.id}" title="React">
                    <i class="bi bi-heart"></i>
                    <span class="card-heart-count">0</span>
                </button>
            </div>
        `;
        d.onclick = () => { showReviewerDetail(rv); };
        // wire card-level heart button
        const btn = d.querySelector('.card-heart-btn');
        if (btn) {
            btn.addEventListener('click', async (ev) => {
                ev.stopPropagation();
                const id = btn.dataset.reviewerId;
                if (!id) return;
                btn.disabled = true;
                try {
                    const resp = await fetch(`/api/reviewers/${id}/reactions`, {
                        method: 'POST',
                        credentials: 'include',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ reaction: 'heart' })
                    });
                    let data = null;
                    try { data = await resp.json(); } catch (e) {}
                    if (resp.status === 403) {
                        window.showAlert && window.showAlert('error', 'You cannot react to your own reviewer', 3000);
                        if (data && typeof data.count !== 'undefined') updateCard(btn, data.count, data.reacted);
                    } else if (data && typeof data.count !== 'undefined') {
                        updateCard(btn, data.count, data.reacted);
                    } else {
                        const cntEl = btn.querySelector('.card-heart-count');
                        const cur = Number(cntEl?.textContent || 0) || 0;
                        const willReact = !btn.classList.contains('hearted');
                        updateCard(btn, willReact ? cur+1 : Math.max(0, cur-1), willReact);
                    }
                } catch (err) {
                    console.error('Card reaction error', err);
                } finally {
                    btn.disabled = false;
                }
            });
            // load initial reaction count for this card (guests should see count)
            (async () => {
                try {
                    const r = await fetch(`/api/reviewers/${rv.id}/reactions`);
                    let data = null;
                    try { data = await r.json(); } catch (err) { /* ignore */ }
                    if (data && typeof data.count !== 'undefined') updateCard(btn, data.count, data.reacted);
                } catch (e) {
                    console.warn('Failed to load reactions for reviewer', rv.id, e);
                }
            })();
        }
        return d;
    }

    function updateCard(btn, count, reacted) {
        if (!btn) return;
        const icon = btn.querySelector('i');
        const cntEl = btn.querySelector('.card-heart-count');
        if (reacted) {
            btn.classList.add('hearted');
            if (icon) icon.className = 'bi bi-heart-fill';
        } else {
            btn.classList.remove('hearted');
            if (icon) icon.className = 'bi bi-heart';
        }
        if (cntEl) cntEl.textContent = Number(count) || 0;
    }

    async function loadMore() {
        if (loading || finished) return;
        loading = true;
        loadingEl.style.display = 'block';
        loadMoreWrap.style.display = 'none';
        try {
            const resp = await fetch(`/api/users/${encodeURIComponent(userId)}/reviewers?limit=${limit}&offset=${offset}&search=${encodeURIComponent(currentQuery)}`);
            if (!resp.ok) throw new Error('Failed');
            const data = await resp.json();
            const reviewers = data.reviewers || [];
            
            // Store all reviewers data for subject filtering
            allReviewersData = allReviewersData.concat(reviewers);
            
            // Filter based on selected subject if in subject view mode
            const displayReviewers = selectedSubject 
                ? reviewers.filter(rv => rv.subjects?.name === selectedSubject)
                : reviewers;
            
            displayReviewers.forEach(rv => reviewersContainer.appendChild(makeCard(rv)));
            offset += reviewers.length;
            if (reviewers.length < limit) {
                finished = true;
            }
            if (!finished) {
                loadMoreWrap.style.display = 'block';
            }
        } catch (e) {
            console.error('Failed to load reviewers', e);
        } finally {
            loading = false;
            loadingEl.style.display = 'none';
        }
    }

    function resetAndSearch() {
        offset = 0; finished = false; reviewersContainer.innerHTML = ''; allReviewersData = [];
        currentQuery = searchInput.value.trim();
        selectedSubject = null;
        loadMore();
    }

    function extractSubjects() {
        const subjects = new Set();
        allReviewersData.forEach(rv => {
            if (rv.subjects && rv.subjects.name) {
                subjects.add(rv.subjects.name);
            }
        });
        return Array.from(subjects).sort();
    }

    function showSubjectFilter() {
        viewMode = 'subjects';
        const subjects = extractSubjects();
        const subjectPills = document.getElementById('subjectPills');
        const subjectPillsContainer = document.getElementById('subjectPillsContainer');
        
        if (subjects.length === 0) {
            window.showAlert && window.showAlert('info', 'No subjects found for this user\'s reviewers');
            return;
        }
        
        subjectPillsContainer.innerHTML = '';
        subjects.forEach(subject => {
            const pill = document.createElement('button');
            pill.className = 'btn btn-sm btn-outline';
            pill.textContent = subject;
            pill.style.cssText = 'padding: 4px 12px; font-size: 0.85rem;';
            pill.onclick = () => filterBySubject(subject);
            subjectPillsContainer.appendChild(pill);
        });
        
        subjectPills.style.display = 'block';
        
        // Update button states
        document.getElementById('filterAllReviewers').classList.remove('btn-primary');
        document.getElementById('filterAllReviewers').classList.add('btn-outline');
        document.getElementById('filterSubjects').classList.remove('btn-outline');
        document.getElementById('filterSubjects').classList.add('btn-primary');
    }

    function filterBySubject(subject) {
        selectedSubject = subject;
        reviewersContainer.innerHTML = '';
        
        // Highlight selected subject pill
        const pills = document.querySelectorAll('#subjectPillsContainer button');
        pills.forEach(pill => {
            if (pill.textContent === subject) {
                pill.classList.remove('btn-outline');
                pill.classList.add('btn-primary');
            } else {
                pill.classList.remove('btn-primary');
                pill.classList.add('btn-outline');
            }
        });
        
        // Display only reviewers with the selected subject
        const filtered = allReviewersData.filter(rv => rv.subjects?.name === subject);
        filtered.forEach(rv => reviewersContainer.appendChild(makeCard(rv)));
        
        if (filtered.length === 0) {
            reviewersContainer.innerHTML = '<div style="text-align:center;padding:20px;color:var(--dark-gray);">No reviewers found for this subject</div>';
        }
    }

    function showAllReviewers() {
        viewMode = 'all';
        selectedSubject = null;
        document.getElementById('subjectPills').style.display = 'none';
        
        // Update button states
        document.getElementById('filterAllReviewers').classList.remove('btn-outline');
        document.getElementById('filterAllReviewers').classList.add('btn-primary');
        document.getElementById('filterSubjects').classList.remove('btn-primary');
        document.getElementById('filterSubjects').classList.add('btn-outline');
        
        // Re-render all reviewers
        reviewersContainer.innerHTML = '';
        allReviewersData.forEach(rv => reviewersContainer.appendChild(makeCard(rv)));
    }

    // Wire interactions
    loadMoreBtn.addEventListener('click', loadMore);
    searchInput.addEventListener('input', debounce(resetAndSearch, 400));
    // Search button removed; input event handles searches
    
    // Wire filter buttons
    document.getElementById('filterAllReviewers').addEventListener('click', showAllReviewers);
    document.getElementById('filterSubjects').addEventListener('click', showSubjectFilter);

    // initial
    fetchUser().then(loadMore);

    // Wire profile-level message/back interactions
    document.addEventListener('DOMContentLoaded', () => {
        const msgBtn = document.getElementById('messageBtn');
        const backSmall = document.getElementById('profileBackSmall');
        if (backSmall) backSmall.addEventListener('click', () => window.history.back());

        if (msgBtn) {
            // Fetch current user non-destructively to decide button behavior
            (async () => {
                try {
                    const resp = await fetch('/api/auth/me', { credentials: 'include' });
                    if (resp.ok) {
                        const data = await resp.json();
                        _loggedInUserId = data.user && data.user.id ? data.user.id : null;
                        // If the logged-in user is viewing their own profile, show a Dashboard button instead
                        if (_loggedInUserId && String(_loggedInUserId) === String(userId)) {
                            msgBtn.textContent = 'Dashboard';
                            msgBtn.title = 'Go to your dashboard';
                            msgBtn.classList.remove('btn-primary');
                            msgBtn.classList.add('btn-light');
                            msgBtn.onclick = () => { window.location.href = '/dashboard.html'; };
                            return;
                        }
                    }
                } catch (e) {
                    // ignore errors and fall back to message behavior
                }

                // Default behavior: redirect to chat page for private conversation
                msgBtn.addEventListener('click', async () => {
                    try {
                        const resp = await fetch('/api/auth/me', { credentials: 'include' });
                        if (!resp.ok) return window.location.href = '/login';
                        const data = await resp.json();
                        // Prevent messaging yourself as a safety check
                        try {
                            if (data && data.user && String(data.user.id) === String(userId)) {
                                window.showAlert && window.showAlert('error', 'You cannot message yourself', 3000);
                                return;
                            }
                        } catch (e) {}
                        // Navigate to chat page and open private chat with this user
                        const target = '/chat.html';
                        const qs = new URLSearchParams();
                        qs.set('with', String(userId));
                        window.location.href = target + '?' + qs.toString();
                    } catch (e) {
                        return window.location.href = '/login';
                    }
                });
            })();
        }
    });

    // small helpers
    function escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text || '';
        return div.innerHTML;
    }

    function stripHtml(html) {
        const tmp = document.createElement('div');
        tmp.innerHTML = html || '';
        return tmp.textContent || tmp.innerText || '';
    }

    function debounce(fn, wait) {
        let t;
        return function(...args) {
            clearTimeout(t);
            t = setTimeout(() => fn.apply(this, args), wait);
        };
    }

    // Show reviewer detail modal. If a global implementation exists, use it.
    async function showReviewerDetail(rv) {
        // Navigate to reviewer detail page
        window.location.href = `/reviewer.html?id=${rv.id}`;
    }

    // Close modal (exposed globally for onclick handlers)
    function closeModal() {
        const m = document.getElementById('reviewerModal');
        if (m) m.classList.remove('show');
    }

    // Render heart button state
    function renderHeartButton(id, count = 0, reacted = false) {
        const btn = document.getElementById('heartBtn');
        const icon = document.getElementById('heartIcon');
        const countEl = document.getElementById('heartCount');
        if (!btn || !icon || !countEl) return;
        if (reacted) {
            btn.classList.add('hearted');
            icon.className = 'bi bi-heart-fill';
        } else {
            btn.classList.remove('hearted');
            icon.className = 'bi bi-heart';
        }
        countEl.textContent = Number(count) || 0;
    }

    // Toggle heart reaction for current modal reviewer
    async function toggleHeartCurrent() {
        const modal = document.getElementById('reviewerModal');
        const id = modal?.dataset?.currentReviewerId;
        if (!id) return;
        try {
            const resp = await fetch(`/api/reviewers/${id}/reactions`, {
                method: 'POST',
                credentials: 'include',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ reaction: 'heart' })
            });
            let data;
            if (!resp.ok) {
                if (resp.status === 401) {
                    window.showAlert && window.showAlert('error', 'Please log in to react', 3000);
                    return;
                }
                try { data = await resp.json(); } catch (e) { data = null; }
            } else {
                data = await resp.json();
            }
            if (resp.status === 403) {
                // show owner alert
                try {
                    const errData = data || (await resp.json());
                    window.showAlert && window.showAlert('error', 'You cannot react to your own reviewer', 3000);
                    if (errData && typeof errData.count !== 'undefined') renderHeartButton(id, errData.count, errData.reacted);
                } catch (e) {
                    window.showAlert && window.showAlert('error', 'You cannot react to your own reviewer', 3000);
                }
            } else if (data && (typeof data.count !== 'undefined')) {
                renderHeartButton(id, data.count, data.reacted);
            } else {
                const current = Number(document.getElementById('heartCount')?.textContent || 0) || 0;
                const reactedNow = !document.getElementById('heartBtn')?.classList.contains('hearted');
                renderHeartButton(id, reactedNow ? current + 1 : Math.max(0, current - 1), reactedNow);
            }
        } catch (e) {
            console.error('Toggle heart error', e);
        }
    }

    // Save as PDF (uses same simplified print flow)
    function saveAsPdf() {
        const title = document.getElementById('modalTitle')?.textContent || '';
        const contentHtml = document.getElementById('modalContent')?.innerHTML || '';

        const printWin = window.open('', '_blank');
        if (!printWin) return alert('Unable to open print window');

        let styles = '';
        document.querySelectorAll('style').forEach(s => { styles += s.outerHTML; });
        document.querySelectorAll('link[rel="stylesheet"]').forEach(l => { styles += l.outerHTML; });

        const html = `
            <html>
            <head>
                <meta charset="utf-8">
                <title>${escapeHtml(title)}</title>
                ${styles}
                <style>
                    body { background: white; color: #333; }
                    .print-container { max-width: 900px; margin: 20px auto; font-family: inherit; }
                    .print-title { font-size: 1.5rem; font-weight: 700; margin-bottom: 12px; }
                    .print-content { line-height: 1.6; }
                    button, .btn { display: none !important; }
                </style>
            </head>
            <body>
                <div class="print-container">
                    <div class="print-title">${escapeHtml(title)}</div>
                    <div class="print-content">${contentHtml}</div>
                </div>
            </body>
            </html>
        `;

        printWin.document.open();
        printWin.document.write(html);
        printWin.document.close();
        setTimeout(() => { printWin.focus(); printWin.print(); }, 500);
    }

    // Expose global functions used by inline handlers
    window.closeModal = closeModal;
    window.toggleHeartCurrent = toggleHeartCurrent;
    window.saveAsPdf = saveAsPdf;
    // Message modal helpers
    function openMessageModal(currentUser) {
        const modal = document.getElementById('messageModal');
        const recipientName = document.getElementById('messageRecipientName');
        const txt = document.getElementById('messageText');
        if (recipientName) recipientName.textContent = displayNameEl.textContent || usernameEl.textContent || 'User';
        if (txt) txt.value = '';
        if (modal) modal.classList.add('show');
        // remember the current logged-in user id for styling messages
        try { _loggedInUserId = currentUser && currentUser.id ? currentUser.id : null; } catch(e) { _loggedInUserId = null; }
        const sendBtn = document.getElementById('sendMessageBtn');
        if (sendBtn) {
            sendBtn.disabled = false;
            sendBtn.onclick = async () => {
                const body = (document.getElementById('messageText') || {}).value || '';
                if (!body.trim()) return window.showAlert && window.showAlert('error', 'Message cannot be empty', 2500);
                sendBtn.disabled = true;
                try {
                    const sresp = await fetch('/api/messages', {
                        method: 'POST',
                        credentials: 'include',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ message: body, chat_type: 'private', recipient_id: userId })
                    });
                    if (!sresp.ok) {
                        if (sresp.status === 401) return window.location.href = '/login';
                        const err = await sresp.json().catch(() => ({}));
                        window.showAlert && window.showAlert('error', err.error || 'Failed to send message', 3000);
                        return;
                    }
                    window.showAlert && window.showAlert('success', 'Message sent', 2500);
                    // clear input and refresh thread
                    const mtxt = document.getElementById('messageText'); if (mtxt) mtxt.value = '';
                    await fetchMessageThread();
                } catch (e) {
                    console.error('Send message error', e);
                    window.showAlert && window.showAlert('error', 'Failed to send message', 3000);
                } finally {
                    sendBtn.disabled = false;
                }
            };
        }
        // load existing messages for this private conversation
        fetchMessageThread();
    }

    async function fetchMessageThread() {
        const threadEl = document.getElementById('messageThread');
        if (!threadEl) return;
        threadEl.innerHTML = '<div style="text-align:center;color:var(--dark-gray);padding:24px;">Loading messages...</div>';
        try {
            const url = `/api/messages/private?with=${encodeURIComponent(userId)}&limit=200`;
            const resp = await fetch(url, { credentials: 'include' });
            console.debug('fetchMessageThread response', url, resp.status);
            if (resp.status === 401) {
                console.warn('fetchMessageThread: not authenticated');
                return window.location.href = '/login';
            }
            const txt = await resp.text();
            let data;
            try { data = JSON.parse(txt); } catch (e) { data = txt; }
            if (!resp.ok) {
                console.error('Failed to load messages', resp.status, data);
                throw new Error('Failed to load messages');
            }
            const msgs = (data && data.messages) ? data.messages : (Array.isArray(data) ? data : []);
            if (msgs.length === 0) {
                threadEl.innerHTML = '<div style="text-align:center;color:var(--dark-gray);padding:16px;">No messages yet</div>';
                return;
            }
            // Render messages as chat bubbles. mark messages from the logged-in user as self.
            threadEl.innerHTML = msgs.map(m => {
                const isSelf = _loggedInUserId && (String(m.user_id) === String(_loggedInUserId));
                const classes = isSelf ? 'msg msg-self' : 'msg';
                const who = escapeHtml(m.username || 'User');
                const time = new Date(m.created_at).toLocaleString();
                const avatar = m.users && m.users.profile_picture_url ? m.users.profile_picture_url : '/images/default-avatar.svg';
                return `
                        <div class="${classes}">
                            <img class="msg-avatar" src="${avatar}" onerror="this.onerror=null;this.src='/images/default-avatar.svg'"/>
                            <div class="msg-body">
                                <div class="msg-bubble ${isSelf ? 'right' : 'left'}">
                                    <div class="msg-meta"><span class="msg-author">${who}</span></div>
                                    <div class="msg-text">${escapeHtml(m.message)}</div>
                                </div>
                                <div class="msg-time-below">${time}</div>
                            </div>
                        </div>
                    `;
            }).join('');
            // scroll to bottom
            threadEl.scrollTop = threadEl.scrollHeight;
        } catch (e) {
            console.error('Failed to load message thread', e);
            threadEl.innerHTML = '<div style="text-align:center;color:var(--dark-gray);padding:16px;">Failed to load messages</div>';
        }
    }

    function closeMessageModal() {
        const m = document.getElementById('messageModal');
        if (m) m.classList.remove('show');
    }
    window.openMessageModal = openMessageModal;
    window.closeMessageModal = closeMessageModal;
})();
