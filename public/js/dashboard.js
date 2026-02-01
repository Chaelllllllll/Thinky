/**
 * Dashboard JavaScript
 * Handles subject and reviewer management
 */

let currentUser = null;
let subjects = [];
let currentSubjectId = null;
let currentReviewerId = null;
let quill = null;

// Initialize Quill editor
document.addEventListener('DOMContentLoaded', () => {
    // Initialize Quill
    quill = new Quill('#editor', {
        theme: 'snow',
        modules: {
            toolbar: [
                [{ 'header': [1, 2, 3, false] }],
                ['bold', 'italic', 'underline', 'strike'],
                [{ 'list': 'ordered'}, { 'list': 'bullet' }],
                [{ 'color': [] }, { 'background': [] }],
                ['code-block'],
                ['link'],
                ['clean']
            ]
        }
    });

    // Preserve modal scroll position on paste to avoid modal jumping to top
    try {
        const reviewerModalBody = document.querySelector('#reviewerModal .modal-body');
        if (quill && reviewerModalBody) {
            quill.root.addEventListener('paste', (ev) => {
                // remember scroll position
                const prevScroll = reviewerModalBody.scrollTop;
                // after Quill handles paste, restore scroll so toolbar and view don't jump
                setTimeout(() => { try { reviewerModalBody.scrollTop = prevScroll; } catch (e) { /* ignore */ } }, 50);
            });
        }
    } catch (e) {
        // ignore if anything goes wrong
        console.warn('Could not attach paste handler to quill:', e);
    }

    // Load user data
    loadCurrentUser();
    loadSchools();
    loadSubjects();

    // If redirected after verification, show a success toast and clean the URL
    try {
        const params = new URLSearchParams(window.location.search);
        if (params.get('verified') === '1') {
            window.showAlert && window.showAlert('success', 'Your account has been verified');
            // remove query param without reloading
            params.delete('verified');
            const newUrl = window.location.pathname + (params.toString() ? ('?' + params.toString()) : '');
            window.history.replaceState({}, document.title, newUrl);
        }
        
        // Check if a reviewer ID is in the URL (from moderation links)
        const reviewerId = params.get('reviewer');
        if (reviewerId) {
            // Try to open the reviewer modal repeatedly until data is ready or timeout
            (function attemptOpen(retry = 0) {
                const MAX_RETRIES = 12; // ~12 * 700ms = ~8.4s
                const RETRY_DELAY = 700;
                (async () => {
                    try {
                        await viewReviewer(reviewerId);
                        return; // success
                    } catch (e) {
                        if (retry < MAX_RETRIES) {
                            setTimeout(() => attemptOpen(retry + 1), RETRY_DELAY);
                        } else {
                            console.error('Failed to open reviewer from URL after retries:', e);
                        }
                    }
                })();
            })();
        }
    } catch (e) {
        // ignore
    }

    // Update online status every 30 seconds
    setInterval(updateOnlineStatus, 30000);
    updateOnlineStatus();

    // Wire Add Flashcard button (dynamic rows)
    const addFlashBtn = document.getElementById('addFlashcardBtn');
    if (addFlashBtn) addFlashBtn.addEventListener('click', () => addFlashcardRow());
    // Ensure at least one empty flashcard input exists for new reviewer
    const flashList = document.getElementById('flashcardsList');
    if (flashList && flashList.children.length === 0) addFlashcardRow();
});

async function loadCurrentUser() {
    try {
        const response = await fetch('/api/auth/me', { credentials: 'include' });
        if (!response.ok) {
            window.location.href = '/login';
            return;
        }

        const data = await response.json();
        currentUser = data.user;
        document.getElementById('username').textContent = currentUser.username;
    } catch (error) {
        console.error('Error loading user:', error);
        window.location.href = '/login';
    }
}

// Load verified schools and populate select
async function loadSchools() {
    try {
        const response = await fetch('/api/schools', { credentials: 'include' });
        if (!response.ok) throw new Error('Failed to load schools');
        const data = await response.json();
        const select = document.getElementById('subjectSchool');
        if (!select) return;
        // Clear existing options except placeholder
        select.innerHTML = '<option value="">Select a school</option>';
        (data.schools || []).forEach(s => {
            const opt = document.createElement('option');
            opt.value = s.id || s.name || s;
            opt.textContent = s.name || s;
            select.appendChild(opt);
        });
    } catch (error) {
        console.warn('Could not load schools:', error);
    }
}

async function loadSubjects() {
    try {
        document.getElementById('loadingSubjects').style.display = 'block';
        document.getElementById('subjectsGrid').style.display = 'none';
        document.getElementById('emptySubjects').style.display = 'none';

        const response = await fetch('/api/subjects', { credentials: 'include' });
        if (!response.ok) throw new Error('Failed to load subjects');

        const data = await response.json();
        subjects = data.subjects;

        // Update stats (only if elements exist in DOM)
        const totalReviewers = subjects.reduce((sum, subject) => sum + (subject.reviewers?.length || 0), 0);
        const elTotalSubjects = document.getElementById('totalSubjects');
        if (elTotalSubjects) elTotalSubjects.textContent = subjects.length;

        // Load reviewers count
        await updateReviewersStats();

        document.getElementById('loadingSubjects').style.display = 'none';

        if (subjects.length === 0) {
            document.getElementById('emptySubjects').style.display = 'block';
        } else {
            document.getElementById('subjectsGrid').style.display = 'grid';
            displaySubjects();
        }
    } catch (error) {
        console.error('Error loading subjects:', error);
        document.getElementById('loadingSubjects').style.display = 'none';
        document.getElementById('emptySubjects').style.display = 'block';
    }
}

async function updateReviewersStats() {
    let totalReviewers = 0;
    let publicReviewers = 0;

    for (const subject of subjects) {
        try {
            // Use paginated endpoint to retrieve count without pulling all rows
            const response = await fetch(`/api/subjects/${subject.id}/reviewers?limit=1&offset=0`, { credentials: 'include' });
            if (response.ok) {
                const data = await response.json();
                subject.reviewers = subject.reviewers || [];
                const count = data.count || 0;
                totalReviewers += count;

                // If we need public count specifically, fallback to requesting a small page and counting
                // here we attempt a small page to estimate public reviewers
                const resp2 = await fetch(`/api/subjects/${subject.id}/reviewers?limit=50&offset=0`, { credentials: 'include' });
                if (resp2.ok) {
                    const d2 = await resp2.json();
                    publicReviewers += (d2.reviewers || []).filter(r => r.is_public).length;
                }
            }
        } catch (error) {
            console.error(`Error loading reviewers for subject ${subject.id}:`, error);
        }
    }

    const elTotalReviewers = document.getElementById('totalReviewers');
    if (elTotalReviewers) elTotalReviewers.textContent = totalReviewers;
    const elPublicReviewers = document.getElementById('publicReviewers');
    if (elPublicReviewers) elPublicReviewers.textContent = publicReviewers;
}

function displaySubjects() {
    const grid = document.getElementById('subjectsGrid');
    grid.innerHTML = '';

    subjects.forEach(subject => {
        const reviewersCount = subject.reviewers?.length || 0;
        
        const card = document.createElement('div');
        card.className = 'subject-card';
        card.innerHTML = `
            <div class="subject-header-row">
                <div>
                    <div class="subject-name">${escapeHtml(subject.name)}</div>
                    ${subject.description ? `<div class="subject-description">${escapeHtml(subject.description)}</div>` : ''}
                </div>
                <div class="subject-meta">
                    <div style="text-align:right; font-size:0.9rem; color:var(--dark-gray);">
                        <div>${reviewersCount} reviewer${reviewersCount !== 1 ? 's' : ''}</div>
                        <div style="margin-top:6px;">${new Date(subject.created_at).toLocaleDateString()}</div>
                    </div>
                </div>
            </div>
            <div class="subject-actions">
                <button class="btn btn-accent btn-sm" onclick="openReviewerModal('${subject.id}')">
                    <i class="bi bi-plus"></i> Add Reviewer
                </button>
                <button class="btn btn-light btn-sm" onclick="openReviewersList('${subject.id}')">
                    <i class="bi bi-eye"></i> View Reviewers
                </button>
                <button class="btn btn-light btn-sm" onclick="editSubject('${subject.id}')">
                    <i class="bi bi-pencil"></i>
                </button>
                <button class="btn btn-danger btn-sm" onclick="deleteSubject('${subject.id}')">
                    <i class="bi bi-trash"></i>
                </button>
            </div>
        `;
        grid.appendChild(card);
    });
}

// Opens a modal listing reviewers for a subject
async function openReviewersList(subjectId) {
    const modal = document.getElementById('reviewersListModal');
    const container = document.getElementById('reviewersListContainer');
    const title = document.getElementById('reviewersListTitle');

    const subject = subjects.find(s => s.id === subjectId);
    if (!subject) return;

    title.textContent = `Reviewers — ${subject.name}`;

    // Setup paging state per subject
    if (!window._reviewersPaging) window._reviewersPaging = {};
    window._reviewersPaging[subjectId] = {
        offset: 0,
        limit: 10,
        loading: false,
        finished: false,
        count: null,
        search: '',
        requestId: 0
    };

    container.innerHTML = `<div style="padding:20px;text-align:center;color:var(--dark-gray);">Loading reviewers...</div>`;

    // Wire up search input (fixed, not part of scrollable area)
    const searchEl = document.getElementById('reviewersListSearch');
    if (searchEl) {
        searchEl.value = '';
        // Debounced search
        let searchTimer = null;
        const onInput = (e) => {
            clearTimeout(searchTimer);
            searchTimer = setTimeout(async () => {
                const term = (e.target.value || '').trim();
                const paging = window._reviewersPaging[subjectId];
                // Bump requestId to invalidate any in-flight requests
                paging.requestId++;
                paging.search = term;
                paging.offset = 0;
                paging.finished = false;
                paging.count = null;
                container.innerHTML = `<div style="padding:20px;text-align:center;color:var(--dark-gray);">Loading reviewers...</div>`;
                await loadMoreReviewers(subjectId);
            }, 300);
        };
        // store to remove later
        searchEl._reviewersInputHandler = onInput;
        searchEl.removeEventListener('input', onInput);
        searchEl.addEventListener('input', onInput);
    }

    // Load initial batch and setup infinite scroll
    await loadMoreReviewers(subjectId);

    // Attach scroll handler to modal body to load more when near bottom
    const onScroll = async () => {
        const el = container;
        const paging = window._reviewersPaging[subjectId];
        if (!el || paging.loading || paging.finished) return;
        const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
        if (nearBottom) await loadMoreReviewers(subjectId);
    };

    // ensure container is scrollable
    container.style.maxHeight = '60vh';
    container.style.overflow = 'auto';
    // store handler to remove on close
    container._reviewersOnScroll = onScroll;
    container.removeEventListener('scroll', onScroll);
    container.addEventListener('scroll', onScroll);

    modal.classList.add('show');
}

// Fetch next page of reviewers for a subject and append to the container
async function loadMoreReviewers(subjectId) {
    const paging = window._reviewersPaging?.[subjectId];
    const container = document.getElementById('reviewersListContainer');
    if (!paging || paging.loading || paging.finished) return;
    paging.loading = true;
    // mark this request with an id so we can ignore stale responses
    const thisReq = ++paging.requestId;
    let url = `/api/subjects/${subjectId}/reviewers?limit=${paging.limit}&offset=${paging.offset}`;
    if (paging.search) url += `&search=${encodeURIComponent(paging.search)}`;
    try {
        const resp = await fetch(url, { credentials: 'include' });
        if (!resp.ok) throw new Error('Failed to load reviewers');
        // If another request started after this one, ignore this response
        if (paging.requestId !== thisReq) return;
        const data = await resp.json();
        const reviewers = data.reviewers || [];

        // Initialize container when first load
        if (paging.offset === 0) {
            if (reviewers.length === 0) {
                container.innerHTML = `<div style="padding:20px;text-align:center;color:var(--dark-gray);">No reviewers for this subject.</div>`;
                paging.finished = true;
                paging.count = data.count || 0;
                return;
            }
            container.innerHTML = '';
        }

        // Ensure subject cache exists and append reviewers to it
        const subject = subjects.find(s => s.id === subjectId);
        if (subject) subject.reviewers = subject.reviewers || [];

        // Append reviewers
        reviewers.forEach(r => {
            // cache in subject.reviewers if not already present
            if (subject) {
                const exists = subject.reviewers.some(rr => rr.id === r.id);
                if (!exists) subject.reviewers.push(r);
            }
            const row = document.createElement('div');
            row.className = 'reviewer-row';
            row.innerHTML = `
                <div>
                    <div class="reviewer-title">${escapeHtml(r.title)}</div>
                    <div style="font-size:0.85rem;color:var(--dark-gray);margin-top:6px;">${r.is_public ? '<span class="badge badge-success">Public</span>' : '<span class="badge badge-primary">Private</span>'}</div>
                </div>
                <div style="display:flex;gap:8px;align-items:center;">
                    <button class="btn btn-light btn-sm" onclick="viewReviewer('${r.id}')"><i class="bi bi-eye"></i></button>
                    <button class="btn btn-light btn-sm" onclick="editReviewer('${r.id}','${subjectId}')"><i class="bi bi-pencil"></i></button>
                    <button class="btn btn-danger btn-sm" onclick="deleteReviewer('${r.id}','${subjectId}')"><i class="bi bi-trash"></i></button>
                </div>
            `;
            container.appendChild(row);
        });

        paging.offset += reviewers.length;
        paging.count = data.count || paging.count;

        // If we've loaded all or received fewer than requested, mark finished
        if (reviewers.length < paging.limit || (paging.count !== null && paging.offset >= paging.count)) {
            paging.finished = true;
            if (paging.offset === 0 && reviewers.length === 0) {
                container.innerHTML = `<div style="padding:20px;text-align:center;color:var(--dark-gray);">No reviewers for this subject.</div>`;
            }
        }
    } catch (err) {
        console.error('Failed to load reviewers for list:', err);
        if (paging.offset === 0) {
            container.innerHTML = `<div style="padding:20px;text-align:center;color:var(--dark-gray);">Failed to load reviewers.</div>`;
        }
    } finally {
        paging.loading = false;
    }
}

function closeReviewersListModal() {
    const modal = document.getElementById('reviewersListModal');
    // Remove dynamic handlers (search + scroll) to avoid leaks
    const searchEl = document.getElementById('reviewersListSearch');
    if (searchEl && searchEl._reviewersInputHandler) {
        searchEl.removeEventListener('input', searchEl._reviewersInputHandler);
        delete searchEl._reviewersInputHandler;
    }
    const container = document.getElementById('reviewersListContainer');
    if (container && container._reviewersOnScroll) {
        container.removeEventListener('scroll', container._reviewersOnScroll);
        delete container._reviewersOnScroll;
    }

    modal.classList.remove('show');
}

// Subject Modal Functions
function openSubjectModal(subjectId = null) {
    currentSubjectId = subjectId;
    const modal = document.getElementById('subjectModal');
    const title = document.getElementById('subjectModalTitle');

    if (subjectId) {
        const subject = subjects.find(s => s.id === subjectId);
        title.textContent = 'Edit Subject';
        document.getElementById('subjectName').value = subject.name;
        document.getElementById('subjectDescription').value = subject.description || '';
        // Pre-select saved school if available. Schools may be loaded async,
        // so attempt to set immediately and retry briefly if options aren't yet populated.
        try {
            const select = document.getElementById('subjectSchool');
            const schoolVal = subject.school || subject.school_id || '';
            if (select) {
                // Try immediate set first
                if (schoolVal) select.value = schoolVal;

                // If the value didn't stick because options not loaded, retry for up to 1s
                if (schoolVal && select.value !== String(schoolVal)) {
                    const start = Date.now();
                    const trySet = () => {
                        if (select.querySelector(`option[value="${schoolVal}"]`)) {
                            select.value = schoolVal;
                            return;
                        }
                        if (Date.now() - start < 1000) {
                            setTimeout(trySet, 100);
                        } else {
                            // Fallback: append an option for the saved school (use name if available)
                            const opt = document.createElement('option');
                            opt.value = schoolVal;
                            opt.textContent = subject.school_name || subject.school_label || 'Saved school';
                            select.appendChild(opt);
                            select.value = schoolVal;
                        }
                    };
                    trySet();
                }
            }
        } catch (e) {
            console.warn('Could not pre-select school', e);
        }
    } else {
        title.textContent = 'Add Subject';
        document.getElementById('subjectForm').reset();
    }

    modal.classList.add('show');
}

function closeSubjectModal() {
    document.getElementById('subjectModal').classList.remove('show');
    document.getElementById('subjectForm').reset();
    currentSubjectId = null;
}

async function saveSubject() {
    const name = document.getElementById('subjectName').value;
    const description = document.getElementById('subjectDescription').value;
    const school = document.getElementById('subjectSchool') ? document.getElementById('subjectSchool').value : '';

    if (!name) {
        alert('Please enter a subject name');
        return;
    }
    if (!school) {
        alert('Please select a school');
        return;
    }
    if (!description) {
        alert('Please enter a description');
        return;
    }

    // Show loading
    document.getElementById('saveSubjectText').style.display = 'none';
    document.getElementById('saveSubjectSpinner').style.display = 'inline-block';
    document.getElementById('saveSubjectBtn').disabled = true;

    try {
        const url = currentSubjectId ? `/api/subjects/${currentSubjectId}` : '/api/subjects';
        const method = currentSubjectId ? 'PUT' : 'POST';

        const response = await fetch(url, {
            method,
            headers: {
                'Content-Type': 'application/json'
            },
            credentials: 'include',
            body: JSON.stringify({ name, description, school })
        });

        if (!response.ok) throw new Error('Failed to save subject');

        closeSubjectModal();
        await loadSubjects();
    } catch (error) {
        console.error('Error saving subject:', error);
        alert('Failed to save subject. Please try again.');
    } finally {
        document.getElementById('saveSubjectText').style.display = 'inline';
        document.getElementById('saveSubjectSpinner').style.display = 'none';
        document.getElementById('saveSubjectBtn').disabled = false;
    }
}

function editSubject(subjectId) {
    openSubjectModal(subjectId);
}

async function deleteSubject(subjectId) {
    if (!confirm('Are you sure you want to delete this subject? All reviewers in this subject will also be deleted.')) {
        return;
    }

    try {
        const response = await fetch(`/api/subjects/${subjectId}`, {
            method: 'DELETE',
            credentials: 'include'
        });

        if (!response.ok) throw new Error('Failed to delete subject');

        await loadSubjects();
    } catch (error) {
        console.error('Error deleting subject:', error);
        alert('Failed to delete subject. Please try again.');
    }
}

// Reviewer Modal Functions
function openReviewerModal(subjectId, reviewerId = null) {
    currentSubjectId = subjectId;
    currentReviewerId = reviewerId;
    const modal = document.getElementById('reviewerModal');
    const title = document.getElementById('reviewerModalTitle');

    // If the reviewers list modal is open, remember that and hide it so the editor modal
    // appears on top. We'll restore it when the editor closes.
    const reviewersListModal = document.getElementById('reviewersListModal');
    if (reviewersListModal && reviewersListModal.classList.contains('show')) {
        window._reviewersListWasOpen = true;
        reviewersListModal.classList.remove('show');
    } else {
        window._reviewersListWasOpen = false;
    }

    document.getElementById('reviewerSubjectId').value = subjectId;

    if (reviewerId) {
        title.textContent = 'Edit Reviewer';
        loadReviewerData(reviewerId, subjectId);
        } else {
        title.textContent = 'Add Reviewer';
        document.getElementById('reviewerForm').reset();
        quill.setContents([]);
        document.getElementById('isPublic').checked = true;
        // clear any existing flashcard rows and ensure one empty pair is present
        try { const container = document.getElementById('flashcardsList'); if (container) { container.innerHTML = ''; addFlashcardRow(); } } catch (e) {}
    }

    modal.classList.add('show');
}

async function loadReviewerData(reviewerId, subjectId) {
    try {
        // Try to find the reviewer in the cached subject reviewers first
        let reviewer = null;
        const subject = subjects.find(s => s.id === subjectId);
        if (subject && subject.reviewers) {
            reviewer = subject.reviewers.find(r => r.id === reviewerId) || null;
        }

        // If not cached, fetch single reviewer from server. If cached but missing flashcards, refresh from server.
        if (!reviewer) {
            const resp = await fetch(`/api/reviewers/${reviewerId}`, { credentials: 'include' });
            if (!resp.ok) throw new Error('Failed to load reviewer');
            const payload = await resp.json();
            reviewer = payload.reviewer;
            // cache it on subject if available
            if (subject) {
                subject.reviewers = subject.reviewers || [];
                const exists = subject.reviewers.some(r => r.id === reviewer.id);
                if (!exists) subject.reviewers.push(reviewer);
            }
        } else {
            // If reviewer exists in cache but doesn't include flashcards, try to fetch the full record
            if (!Array.isArray(reviewer.flashcards) || reviewer.flashcards.length === 0) {
                try {
                    const resp = await fetch(`/api/reviewers/${reviewerId}`, { credentials: 'include' });
                    if (resp.ok) {
                        const payload = await resp.json();
                        reviewer = payload.reviewer;
                        // update cache entry
                        if (subject) {
                            subject.reviewers = subject.reviewers || [];
                            const idx = subject.reviewers.findIndex(r => r.id === reviewer.id);
                            if (idx >= 0) subject.reviewers[idx] = reviewer;
                            else subject.reviewers.push(reviewer);
                        }
                    }
                } catch (e) { /* ignore, continue with cached reviewer */ }
            }
        }

        if (reviewer) {
            document.getElementById('reviewerTitle').value = reviewer.title;
            quill.root.innerHTML = reviewer.content;
            document.getElementById('isPublic').checked = reviewer.is_public;
                    // Populate flashcards textarea from embedded `reviewer.flashcards` if present
                    try {
                        const fcs = Array.isArray(reviewer.flashcards) ? reviewer.flashcards : [];
                        // populate the multi-row term/meaning inputs
                        populateFlashcardsList(fcs.map(fc => ({ id: fc.id || fc._id || '', front: fc.front || fc.meaning || '', back: fc.back || fc.content || '', is_public: !!fc.is_public })));
                    } catch (e) { console.warn('Flashcards population failed', e); }
        }
    } catch (error) {
        console.error('Error loading reviewer:', error);
        alert('Failed to load reviewer data');
    }
}

function closeReviewerModal() {
    document.getElementById('reviewerModal').classList.remove('show');
    // If the reviewers list modal was open before editing, restore it
    if (window._reviewersListWasOpen) {
        const reviewersListModal = document.getElementById('reviewersListModal');
        if (reviewersListModal) reviewersListModal.classList.add('show');
        window._reviewersListWasOpen = false;
    }
    document.getElementById('reviewerForm').reset();
    quill.setContents([]);
    currentReviewerId = null;
}

async function saveReviewer() {
    const title = document.getElementById('reviewerTitle').value;
    const content = quill.root.innerHTML;
    const isPublic = document.getElementById('isPublic').checked;
    const subjectId = document.getElementById('reviewerSubjectId').value;

    if (!title || !content) {
        alert('Please enter a title and content');
        return;
    }

    // Show loading
    document.getElementById('saveReviewerText').style.display = 'none';
    document.getElementById('saveReviewerSpinner').style.display = 'inline-block';
    document.getElementById('saveReviewerBtn').disabled = true;

    try {
        const url = currentReviewerId ? `/api/reviewers/${currentReviewerId}` : '/api/reviewers';
        const method = currentReviewerId ? 'PUT' : 'POST';

        // Include flashcards array from UI (if any)
        const flashcardsFromUI = getFlashcardsFromUI();
        const body = currentReviewerId
            ? Object.assign({ title, content, is_public: isPublic }, flashcardsFromUI.length ? { flashcards: flashcardsFromUI } : {})
            : Object.assign({ subject_id: subjectId, title, content, is_public: isPublic }, flashcardsFromUI.length ? { flashcards: flashcardsFromUI } : {});

        const response = await fetch(url, {
            method,
            headers: {
                'Content-Type': 'application/json'
            },
            credentials: 'include',
            body: JSON.stringify(body)
        });

        if (!response.ok) {
            let errBody = null;
            try { errBody = await response.json(); } catch (e) { errBody = null; }
            const errMsg = (errBody && (errBody.error || errBody.message)) || 'Failed to save reviewer';

            // Determine any expiry info returned by the server
            const until = (errBody && (errBody.blocked_from_creating_until || errBody.banned_until || errBody.blocked_until)) || null;
            let fullMsg = errMsg;
            if (until) {
                try {
                    const untilDt = new Date(until);
                    const now = new Date();
                    if (!isNaN(untilDt.getTime())) {
                        // compute relative duration
                        const diffMs = untilDt - now;
                        let rel = '';
                        if (diffMs <= 0) {
                            rel = 'now';
                        } else {
                            const mins = Math.round(diffMs / 60000);
                            if (mins < 60) rel = `${mins} minute${mins !== 1 ? 's' : ''}`;
                            else if (mins < 60*24) rel = `${Math.round(mins/60)} hour${Math.round(mins/60) !== 1 ? 's' : ''}`;
                            else rel = `${Math.round(mins/60/24)} day${Math.round(mins/60/24) !== 1 ? 's' : ''}`;
                        }
                        fullMsg = `${errMsg} You can post again on ${untilDt.toLocaleString()} (${rel}).`;
                    }
                } catch (e) {
                    // fallback to include raw until
                    fullMsg = `${errMsg} (until: ${until})`;
                }
            }

            // Show site alert using the global helper
            if (window.showAlert) {
                window.showAlert('error', fullMsg, 8000);
            } else {
                alert(fullMsg);
            }
            // stop further processing
            return;
        }

        // Try to update UI optimistically without a full reload.
        let respData = null;
        try { respData = await response.json(); } catch (e) { respData = null; }

        // If this was a new reviewer (no currentReviewerId) and server returned the created reviewer,
        // append it to the local subjects cache and refresh the UI. Otherwise, fallback to reloading subjects.
        if (!currentReviewerId && respData && (respData.reviewer || respData.id || respData.data)) {
            const added = respData.reviewer || respData.data || respData;
            // Ensure we have the numeric/string id to match
            const sid = subjectId || (added.subject_id || added.subjectId || added.subject);
            const subj = subjects.find(s => String(s.id) === String(sid));
            if (subj) {
                subj.reviewers = subj.reviewers || [];
                // avoid duplicates
                if (!subj.reviewers.some(r => String(r.id) === String(added.id))) subj.reviewers.push(added);
                // Refresh subject cards and stats
                displaySubjects();
                updateReviewersStats();
                // (Flashcard creation is handled via the modal UI when the uploader opts in)
            } else {
                // fallback
                await loadSubjects();
            }
        } else {
            await loadSubjects();
        }

        // Flashcards are saved as part of the reviewer payload (if any)
        closeReviewerModal();
    } catch (error) {
        console.error('Error saving reviewer:', error);
        alert('Failed to save reviewer. Please try again.');
    } finally {
        document.getElementById('saveReviewerText').style.display = 'inline';
        document.getElementById('saveReviewerSpinner').style.display = 'none';
        document.getElementById('saveReviewerBtn').disabled = false;
    }
}

function editReviewer(reviewerId, subjectId) {
    openReviewerModal(subjectId, reviewerId);
}

async function deleteReviewer(reviewerId, subjectId) {
    if (!confirm('Are you sure you want to delete this reviewer?')) {
        return;
    }

    try {
        const response = await fetch(`/api/reviewers/${reviewerId}`, {
            method: 'DELETE',
            credentials: 'include'
        });

        if (!response.ok) throw new Error('Failed to delete reviewer');

        await loadSubjects();
    } catch (error) {
        console.error('Error deleting reviewer:', error);
        alert('Failed to delete reviewer. Please try again.');
    }
}

async function viewReviewer(reviewerId) {
    try {
        // Find reviewer in subjects
        let reviewer = null;
        for (const subject of subjects) {
            if (subject.reviewers) {
                reviewer = subject.reviewers.find(r => r.id === reviewerId);
                if (reviewer) break;
            }
        }

        // If not found in cache, fetch it
        if (!reviewer) {
            try {
                const resp = await fetch(`/api/reviewers/${reviewerId}`, { credentials: 'include' });
                if (resp.ok) {
                    const data = await resp.json();
                    reviewer = data.reviewer;
                    // cache it into the related subject if present
                    const subj = subjects.find(s => s.id === reviewer.subject_id);
                    if (subj) {
                        subj.reviewers = subj.reviewers || [];
                        if (!subj.reviewers.some(r => r.id === reviewer.id)) subj.reviewers.push(reviewer);
                    }
                }
            } catch (e) {
                // ignore, will handle below
            }
        }

        if (!reviewer) {
            alert('Reviewer not found');
            return;
        }

        // Hide reviewers list modal if present so the preview shows on top
        const reviewersListModal = document.getElementById('reviewersListModal');
        if (reviewersListModal && reviewersListModal.classList.contains('show')) {
            window._reviewersListWasOpen = true;
            reviewersListModal.classList.remove('show');
        } else {
            window._reviewersListWasOpen = false;
        }

        // If reviewer from cache lacks flashcards, try refresh from server so viewer modal can show them
        if ((!Array.isArray(reviewer.flashcards) || reviewer.flashcards.length === 0)) {
            try {
                const rresp = await fetch(`/api/reviewers/${reviewer.id}`, { credentials: 'include' });
                if (rresp.ok) {
                    const pdata = await rresp.json();
                    reviewer = pdata.reviewer || reviewer;
                }
            } catch (e) { /* ignore */ }
        }

        document.getElementById('viewReviewerTitle').textContent = reviewer.title;
        document.getElementById('viewReviewerContent').innerHTML = reviewer.content;
        const viewModal = document.getElementById('viewReviewerModal');
        // set current reviewer id and owner for footer actions
        viewModal.dataset.currentReviewerId = reviewer.id || '';
        viewModal.dataset.currentReviewerOwner = reviewer.user_id || '';
        // Hide report button if current user is the owner
        try {
            const reportBtn = viewModal.querySelector('.modal-footer .btn-danger');
            if (reportBtn) {
                if (!currentUser || String(currentUser.id) === String(reviewer.user_id)) {
                    reportBtn.style.display = 'none';
                } else {
                    reportBtn.style.display = 'inline-flex';
                }
            }
        } catch (e) { /* ignore DOM issues */ }
        viewModal.classList.add('show');
        // Load and render flashcard for viewer modal (best-effort)
        (async () => {
                try {
                    const flashEl = document.getElementById('viewReviewerFlashcard');
                    if (!flashEl) return;
                    const fcs = Array.isArray(reviewer.flashcards) ? reviewer.flashcards : [];
                    if (!fcs || fcs.length === 0) {
                        flashEl.innerHTML = '';
                        return;
                    }
                    renderFlashcards(flashEl, fcs.map(fc => ({ front: fc.front || fc.meaning || '', back: fc.back || fc.content || '' })));
                } catch (e) { console.warn('Failed to load flashcard', e); }
        })();
    } catch (error) {
        console.error('Error viewing reviewer:', error);
        alert('Failed to view reviewer');
    }
}

function closeViewReviewerModal() {
    document.getElementById('viewReviewerModal').classList.remove('show');
    if (window._reviewersListWasOpen) {
        const reviewersListModal = document.getElementById('reviewersListModal');
        if (reviewersListModal) reviewersListModal.classList.add('show');
        window._reviewersListWasOpen = false;
    }
}

// Utility functions
function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

function stripHtml(html) {
    const tmp = document.createElement('div');
    tmp.innerHTML = html || '';
    return tmp.textContent || tmp.innerText || '';
}

// Render multiple flippable flashcards into a container
function renderFlashcards(container, list) {
    if (!container) return;
    container.innerHTML = '';
    const row = document.createElement('div');
    row.className = 'flashcards-row';
    (list || []).forEach(fc => {
        const el = document.createElement('div');
        el.className = 'flashcard';
        el.tabIndex = 0;

        const inner = document.createElement('div');
        inner.className = 'flashcard-inner';

        const front = document.createElement('div');
        front.className = 'flashcard-face flashcard-front';
        front.innerHTML = `<div class="flashcard-text">${escapeHtml(String(fc.front || ''))}</div>`;

        const back = document.createElement('div');
        back.className = 'flashcard-face flashcard-back';
        back.innerHTML = `<div class="flashcard-text">${escapeHtml(String(stripHtml(fc.back || '')).substring(0,1000))}</div>`;

        inner.appendChild(front);
        inner.appendChild(back);
        el.appendChild(inner);

        // Toggle flip on click or enter/space
        const toggle = () => el.classList.toggle('flipped');
        el.addEventListener('click', toggle);
        el.addEventListener('keydown', (ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); toggle(); } });

        row.appendChild(el);
    });
    container.appendChild(row);
}

function toggleSidebar() {
    document.getElementById('sidebar').classList.toggle('show');
}

async function updateOnlineStatus() {
    try {
        await fetch('/api/online-status', {
            method: 'POST',
            credentials: 'include'
        });
    } catch (error) {
        console.error('Error updating online status:', error);
    }
}

// Flashcards UI helpers
function addFlashcardRow(data = {}) {
    const tpl = document.getElementById('flashcardTemplate');
    const container = document.getElementById('flashcardsList');
    if (!tpl || !container) return;
    const node = tpl.content.firstElementChild.cloneNode(true);
    const idEl = node.querySelector('.flashcard-id'); if (idEl) idEl.value = data.id || '';
    const frontEl = node.querySelector('.flash-front'); if (frontEl) frontEl.value = data.front || '';
    const backEl = node.querySelector('.flash-back'); if (backEl) backEl.value = data.back || '';
    const pubEl = node.querySelector('.flash-public'); if (pubEl) pubEl.checked = data.is_public !== undefined ? !!data.is_public : true;
    const rem = node.querySelector('.remove-flashcard'); if (rem) rem.addEventListener('click', () => { node.remove(); });
    container.appendChild(node);
}

function populateFlashcardsList(list) {
    const container = document.getElementById('flashcardsList');
    if (!container) return;
    container.innerHTML = '';
    (list || []).forEach(f => addFlashcardRow({ id: f.id || '', front: f.front || '', back: f.back || '', is_public: !!f.is_public }));
}

function getFlashcardsFromUI() {
    // Read multi-row flashcard inputs from the UI (term + meaning pairs)
    const out = [];
    const container = document.getElementById('flashcardsList');
    if (!container) return [];
    const rows = Array.from(container.querySelectorAll('.flashcard-row'));
    for (const r of rows) {
        const id = (r.querySelector('.flashcard-id') || {}).value || null;
        const front = (r.querySelector('.flash-front') || {}).value || '';
        const back = (r.querySelector('.flash-back') || {}).value || '';
        const is_public = !!(r.querySelector('.flash-public') && r.querySelector('.flash-public').checked);
        if (!front && !back) continue; // skip empty
        const obj = { front: front.substring(0,1000), back, is_public };
        if (id) obj.id = id;
        try { if (window.currentUser && window.currentUser.id) obj.uploader_id = window.currentUser.id; } catch (e) {}
        out.push(obj);
    }
    return out;
}

async function logout() {
    if (!confirm('Are you sure you want to logout?')) {
        return;
    }

    try {
        await fetch('/api/auth/logout', {
            method: 'POST',
            credentials: 'include'
        });
        window.location.href = '/login';
    } catch (error) {
        console.error('Logout error:', error);
        window.location.href = '/login';
    }
}

// Close modals when clicking outside
document.getElementById('subjectModal')?.addEventListener('click', (e) => {
    if (e.target.id === 'subjectModal') {
        closeSubjectModal();
    }
});

document.getElementById('reviewerModal')?.addEventListener('click', (e) => {
    if (e.target.id === 'reviewerModal') {
        closeReviewerModal();
    }
});

document.getElementById('viewReviewerModal')?.addEventListener('click', (e) => {
    if (e.target.id === 'viewReviewerModal') {
        closeViewReviewerModal();
    }
});

document.getElementById('reviewersListModal')?.addEventListener('click', (e) => {
    if (e.target.id === 'reviewersListModal') {
        closeReviewersListModal();
    }
});
