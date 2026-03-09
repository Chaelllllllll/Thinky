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
    // Build and attach table picker DOM (hidden by default)
    const picker = document.createElement('div');
    picker.id = 'ql-table-picker';
    picker.innerHTML = '<div class="ql-tp-grid"></div><div class="ql-tp-label">0 × 0</div>';
    document.body.appendChild(picker);

    const grid = picker.querySelector('.ql-tp-grid');
    const label = picker.querySelector('.ql-tp-label');
    const MAX_ROWS = 8, MAX_COLS = 8;

    // Populate grid cells
    for (let r = 1; r <= MAX_ROWS; r++) {
        for (let c = 1; c <= MAX_COLS; c++) {
            const cell = document.createElement('div');
            cell.className = 'ql-tp-cell';
            cell.dataset.r = r;
            cell.dataset.c = c;
            grid.appendChild(cell);
        }
    }

    function highlightCells(rows, cols) {
        grid.querySelectorAll('.ql-tp-cell').forEach(el => {
            el.classList.toggle('ql-tp-active', +el.dataset.r <= rows && +el.dataset.c <= cols);
        });
        label.textContent = rows + ' × ' + cols;
    }

    grid.addEventListener('mouseover', e => {
        const cell = e.target.closest('.ql-tp-cell');
        if (cell) highlightCells(+cell.dataset.r, +cell.dataset.c);
    });

    grid.addEventListener('mouseleave', () => highlightCells(0, 0));

    function closePicker() { picker.style.display = 'none'; }

    grid.addEventListener('click', e => {
        const cell = e.target.closest('.ql-tp-cell');
        if (!cell) return;
        const rows = +cell.dataset.r, cols = +cell.dataset.c;
        closePicker();
        if (!quill) return;
        const range = quill.getSelection(true) || { index: quill.getLength() };
        let html = '<table><tbody>';
        for (let r = 0; r < rows; r++) {
            html += '<tr>';
            for (let c = 0; c < cols; c++) html += '<td><br></td>';
            html += '</tr>';
        }
        html += '</tbody></table><p><br></p>';
        quill.clipboard.dangerouslyPasteHTML(range.index, html);
        quill.setSelection(range.index + 1, 0);
    });

    document.addEventListener('click', e => {
        if (!picker.contains(e.target) && !e.target.closest('.ql-table')) closePicker();
    });

    // Initialize Quill
    quill = new Quill('#editor', {
        theme: 'snow',
        modules: {
            toolbar: {
                container: [
                    [{ 'header': [1, 2, 3, false] }],
                    ['bold', 'italic', 'underline', 'strike'],
                    [{ 'list': 'ordered'}, { 'list': 'bullet' }],
                    [{ 'color': [] }, { 'background': [] }],
                    ['code-block'],
                    ['link'],
                    ['table'],
                    ['clean']
                ],
                handlers: {
                    'table': function() {
                        const wrapper = this.quill.container ? this.quill.container.parentElement : null;
                        const btn = wrapper ? wrapper.querySelector('.ql-table') : document.querySelector('.ql-table');
                        if (picker.style.display === 'block') { closePicker(); return; }
                        highlightCells(0, 0);
                        picker.style.display = 'block';
                        if (btn) {
                            const rect = btn.getBoundingClientRect();
                            picker.style.top = (rect.bottom + 4) + 'px';
                            picker.style.left = rect.left + 'px';
                        }
                    }
                }
            }
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

        const elTotalSubjects = document.getElementById('totalSubjects');
        if (elTotalSubjects) elTotalSubjects.textContent = subjects.length;

        document.getElementById('loadingSubjects').style.display = 'none';

        if (subjects.length === 0) {
            document.getElementById('emptySubjects').style.display = 'block';
        } else {
            document.getElementById('subjectsGrid').style.display = 'grid';
            // Show cards immediately with preliminary counts, then refresh with accurate counts
            displaySubjects();
            // updateReviewersStats fetches real counts and calls displaySubjects() again
            await updateReviewersStats();
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
            // Fetch a small page — we need count and a few rows to estimate public count
            const resp = await fetch(`/api/subjects/${subject.id}/reviewers?limit=50&offset=0`, { credentials: 'include' });
            if (resp.ok) {
                const data = await resp.json();
                const count = data.count || 0;
                // Store server-authoritative count and reviewer list on the subject
                subject._reviewerCount = count;
                if (Array.isArray(data.reviewers)) {
                    subject.reviewers = data.reviewers;
                }
                totalReviewers += count;
                publicReviewers += (data.reviewers || []).filter(r => r.is_public).length;
            }
        } catch (error) {
            console.error(`Error loading reviewers for subject ${subject.id}:`, error);
        }
    }

    const elTotalReviewers = document.getElementById('totalReviewers');
    if (elTotalReviewers) elTotalReviewers.textContent = totalReviewers;
    const elPublicReviewers = document.getElementById('publicReviewers');
    if (elPublicReviewers) elPublicReviewers.textContent = publicReviewers;
    // Re-render subject cards with correct counts
    displaySubjects();
}

function displaySubjects() {
    const grid = document.getElementById('subjectsGrid');
    grid.innerHTML = '';

    subjects.forEach(subject => {
        // Prefer the server-authoritative count; fall back to cached array length
        const reviewersCount = subject._reviewerCount ?? subject.reviewers?.length ?? 0;
        
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
                    <button class="btn btn-light btn-sm" title="Manage Quiz" onclick="openQuizBuilder('${r.id}','${escapeAttr(r.title)}')"><i class="bi bi-patch-question"></i></button>
                    <button class="btn btn-light btn-sm" onclick="editReviewer('${r.id}','${subjectId}')"><i class="bi bi-pencil"></i></button>
                    <button class="btn btn-danger btn-sm" onclick="deleteReviewer('${r.id}','${subjectId}')"><i class="bi bi-trash"></i></button>
                </div>
            `;
            container.appendChild(row);
        });

        paging.offset += reviewers.length;
        paging.count = data.count || paging.count;

        // Keep subject card count in sync with server count
        if (subject && data.count !== undefined) subject._reviewerCount = data.count;

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
        // Clear flashcard rows and hide the section for a new reviewer
        try {
            const container = document.getElementById('flashcardsList');
            if (container) container.innerHTML = '';
            const section = document.getElementById('flashcardsSection');
            if (section) section.style.display = 'none';
            const btn = document.getElementById('toggleFlashcardsBtn');
            if (btn) btn.innerHTML = '<i class="bi bi-card-text"></i> Flashcards';
        } catch (e) {}
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
                    // Populate flashcards from embedded `reviewer.flashcards` if present
                    try {
                        const fcs = Array.isArray(reviewer.flashcards) ? reviewer.flashcards : [];
                        // populate the multi-row term/meaning inputs
                        populateFlashcardsList(fcs.map(fc => ({ id: fc.id || fc._id || '', front: fc.front || fc.meaning || '', back: fc.back || fc.content || '', is_public: !!fc.is_public })));
                        // Show flashcard section when editing a reviewer that already has flashcards
                        const section = document.getElementById('flashcardsSection');
                        const btn = document.getElementById('toggleFlashcardsBtn');
                        if (section) section.style.display = fcs.length > 0 ? '' : 'none';
                        if (btn) btn.innerHTML = fcs.length > 0
                            ? '<i class="bi bi-card-text"></i> Hide Flashcards'
                            : '<i class="bi bi-card-text"></i> Flashcards';
                    } catch (e) { console.warn('Flashcards population failed', e); }
        }
    } catch (error) {
        console.error('Error loading reviewer:', error);
        alert('Failed to load reviewer data');
    }
}

function closeReviewerModal() {
    // Block closing while AI generation is in progress
    if (window._aiGenerating) {
        if (window.showAlert) window.showAlert('warning', 'Please wait — generation is still in progress.', 3000);
        return;
    }
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
    // Reset flashcard section state
    try {
        const section = document.getElementById('flashcardsSection');
        if (section) section.style.display = 'none';
        const btn = document.getElementById('toggleFlashcardsBtn');
        if (btn) btn.innerHTML = '<i class="bi bi-card-text"></i> Flashcards';
    } catch (e) {}
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
    const saveTextEl = document.getElementById('saveReviewerText');
    const saveSpinnerEl = document.getElementById('saveReviewerSpinner');
    const saveBtnEl = document.getElementById('saveReviewerBtn');
    saveTextEl.textContent = 'Saving reviewer\u2026';
    saveTextEl.style.display = 'inline';
    saveSpinnerEl.style.display = 'inline-block';
    saveBtnEl.disabled = true;
    window._aiGenerating = true;

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
            // Update currentReviewerId so any subsequent "Save Reviewer" click does a PUT (update)
            // instead of a POST (create), preventing duplicates while the modal stays open.
            if (added.id) {
                currentReviewerId = added.id;
                const modalTitle = document.getElementById('reviewerModalTitle');
                if (modalTitle) modalTitle.textContent = 'Edit Reviewer';
            }
            // Ensure we have the numeric/string id to match
            const sid = subjectId || (added.subject_id || added.subjectId || added.subject);
            const subj = subjects.find(s => String(s.id) === String(sid));
            if (subj) {
                subj.reviewers = subj.reviewers || [];
                // avoid duplicates
                if (!subj.reviewers.some(r => String(r.id) === String(added.id))) {
                    subj.reviewers.push(added);
                    // bump the display count immediately for the new reviewer
                    subj._reviewerCount = (subj._reviewerCount ?? subj.reviewers.length - 1) + 1;
                }
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

        // Capture the saved reviewer ID before closing the modal (closeReviewerModal resets currentReviewerId to null)
        let pendingQuizReviewerId = null;
        if (window._aiPendingQuiz) {
            if (respData) {
                const added = respData.reviewer || respData.data || respData;
                pendingQuizReviewerId = added?.id || null;
            }
            pendingQuizReviewerId = pendingQuizReviewerId || currentReviewerId;
        }

        // If user opted to auto-generate a quiz, do it NOW — keep button disabled until done,
        // then update the local cache so the quiz builder reflects it immediately on open.
        let generationAlertShown = false;
        if (window._aiPendingQuiz && pendingQuizReviewerId) {
            window._aiPendingQuiz = false;
            saveTextEl.textContent = 'Generating quiz\u2026';
            try {
                const savedQuiz = await aiGenerateAndSaveQuizInline(pendingQuizReviewerId);
                // Patch the subjects cache so quiz builder can read it immediately
                for (const subj of (subjects || [])) {
                    if (!subj.reviewers) continue;
                    const rv = subj.reviewers.find(r => String(r.id) === String(pendingQuizReviewerId));
                    if (rv) { rv.quiz = savedQuiz; break; }
                }
                window.showAlert('success', `Reviewer & quiz saved! (${savedQuiz.questions.length} question${savedQuiz.questions.length !== 1 ? 's' : ''}) — You can close this window when you're ready.`, 8000);
                generationAlertShown = true;
            } catch (quizErr) {
                console.error('Inline quiz generation error:', quizErr);
                window.showAlert('error', 'Reviewer saved, but quiz could not be auto-generated. You can create one manually from the quiz builder.');
                generationAlertShown = true;
            }
        } else {
            if (window._aiPendingQuiz) window._aiPendingQuiz = false;
        }

        // Flashcards are saved as part of the reviewer payload (if any)
        // Clear the generation lock — do NOT auto-close; let the user review and close manually
        window._aiGenerating = false;
        if (!generationAlertShown) {
            window.showAlert('success', 'Reviewer saved! You can close this window when you\'re ready.', 5000);
        }
    } catch (error) {
        console.error('Error saving reviewer:', error);
        alert('Failed to save reviewer. Please try again.');
    } finally {
        window._aiGenerating = false;
        saveTextEl.textContent = 'Save Reviewer';
        saveTextEl.style.display = 'inline';
        saveSpinnerEl.style.display = 'none';
        saveBtnEl.disabled = false;
    }
}

function editReviewer(reviewerId, subjectId) {
    openReviewerModal(subjectId, reviewerId);
}

async function deleteReviewer(reviewerId, subjectId) {
    if (!confirm('Are you sure you want to delete this reviewer? This cannot be undone.')) {
        return;
    }

    try {
        const response = await fetch(`/api/reviewers/${reviewerId}`, {
            method: 'DELETE',
            credentials: 'include'
        });

        if (!response.ok) throw new Error('Failed to delete reviewer');

        // Remove from local subjects cache immediately
        const subj = subjects.find(s => String(s.id) === String(subjectId));
        if (subj && subj.reviewers) {
            subj.reviewers = subj.reviewers.filter(r => String(r.id) !== String(reviewerId));
            if (typeof subj._reviewerCount === 'number') subj._reviewerCount = Math.max(0, subj._reviewerCount - 1);
        }

        // Refresh the reviewers list modal in-place (removes the deleted row)
        const listModal = document.getElementById('reviewersListModal');
        if (listModal && listModal.classList.contains('show')) {
            const row = listModal.querySelector(`[onclick*="'${reviewerId}'"]`)?.closest('.reviewer-row');
            if (row) row.remove();
        }

        // Refresh subject cards & stats
        displaySubjects();
        updateReviewersStats();

        if (window.showAlert) window.showAlert('success', 'Reviewer deleted successfully.', 4000);
    } catch (error) {
        console.error('Error deleting reviewer:', error);
        if (window.showAlert) window.showAlert('error', 'Failed to delete reviewer. Please try again.');
        else alert('Failed to delete reviewer. Please try again.');
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
        if (typeof highlightAllCode === 'function') highlightAllCode(document.getElementById('viewReviewerContent'));
        const viewModal = document.getElementById('viewReviewerModal');
        // set current reviewer id and owner for footer actions
        viewModal.dataset.currentReviewerId = reviewer.id || '';
        viewModal.dataset.currentReviewerOwner = reviewer.user_id || '';

        // Conditional footer buttons
        const hasFlashcards = Array.isArray(reviewer.flashcards) && reviewer.flashcards.length > 0;
        const hasQuiz = reviewer.quiz && Array.isArray(reviewer.quiz.questions) && reviewer.quiz.questions.length > 0;
        const viewFlashcardsBtn = document.getElementById('viewFlashcardsBtn');
        const viewQuizBtn = document.getElementById('viewQuizBtn');
        const reportBtn = document.getElementById('viewReportBtn');
        if (viewFlashcardsBtn) viewFlashcardsBtn.style.display = hasFlashcards ? '' : 'none';
        if (viewQuizBtn) viewQuizBtn.style.display = hasQuiz ? '' : 'none';
        if (reportBtn) {
            if (!currentUser || String(currentUser.id) === String(reviewer.user_id)) {
                reportBtn.style.display = 'none';
            } else {
                reportBtn.style.display = 'inline-flex';
            }
        }
        viewModal.classList.add('show');
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

function openQuizFromViewer() {
    const viewModal = document.getElementById('viewReviewerModal');
    const rid = viewModal && viewModal.dataset.currentReviewerId;
    if (rid) window.location.href = `/quiz.html?reviewer=${rid}`;
}

function toggleFlashcardsSection() {
    const section = document.getElementById('flashcardsSection');
    if (!section) return;
    const opening = section.style.display === 'none' || section.style.display === '';
    // Actually check computed visibility
    const isHidden = section.style.display === 'none';
    section.style.display = isHidden ? '' : 'none';
    const btn = document.getElementById('toggleFlashcardsBtn');
    if (btn) btn.innerHTML = isHidden
        ? '<i class="bi bi-card-text"></i> Hide Flashcards'
        : '<i class="bi bi-card-text"></i> Flashcards';
    // Auto-add first row when opening for an empty list
    if (isHidden) {
        const list = document.getElementById('flashcardsList');
        if (list && list.children.length === 0) addFlashcardRow();
    }
}


function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

// Escape a string for safe embedding inside a single-quoted JS attribute (onclick="fn('...')").
function escapeAttr(text) {
    return String(text || '').replace(/\\/g, '\\\\').replace(/'/g, "\\'");
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

// ─── Quiz Builder ─────────────────────────────────────────────────────────────

let _qbReviewerId = null;
let _qbQuestionSeq = 0;

function _qbGenId() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
        const r = Math.random() * 16 | 0;
        return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
    });
}

async function openQuizBuilder(reviewerId, reviewerTitle) {
    _qbReviewerId = reviewerId;
    _qbQuestionSeq = 0;
    document.getElementById('qbReviewerTitle').textContent = reviewerTitle || '';
    document.getElementById('qbQuestionsList').innerHTML = '';
    document.getElementById('qbTimerEnabled').checked = false;
    document.getElementById('qbTimerOptions').style.display = 'none';
    document.getElementById('qbTimerMinutes').value = 15;
    document.getElementById('qbDeleteBtn').style.display = 'none';

    // If reviewer list is open, hide it temporarily
    const listModal = document.getElementById('reviewersListModal');
    if (listModal && listModal.classList.contains('show')) {
        listModal.dataset.wasOpen = '1';
        listModal.classList.remove('show');
    }

    document.getElementById('quizBuilderModal').classList.add('show');

    // Load existing quiz data
    try {
        const resp = await fetch(`/api/reviewers/${reviewerId}`, { credentials: 'include' });
        if (!resp.ok) return;
        const body = await resp.json();
        const quiz = body.reviewer && body.reviewer.quiz;
        if (!quiz || !Array.isArray(quiz.questions) || !quiz.questions.length) return;

        if (quiz.timer) {
            document.getElementById('qbTimerEnabled').checked = true;
            document.getElementById('qbTimerOptions').style.display = 'flex';
            document.getElementById('qbTimerMinutes').value = Math.max(1, Math.round(quiz.timer / 60));
        }
        quiz.questions.forEach(q => qbAddQuestion(q));
        document.getElementById('qbDeleteBtn').style.display = '';
    } catch (e) {
        console.error('Failed to load quiz for builder', e);
    }
}

function closeQuizBuilder() {
    document.getElementById('quizBuilderModal').classList.remove('show');
    const listModal = document.getElementById('reviewersListModal');
    if (listModal && listModal.dataset.wasOpen === '1') {
        listModal.dataset.wasOpen = '';
        listModal.classList.add('show');
    }
    _qbReviewerId = null;
    _qbQuestionSeq = 0;
}

function qbToggleTimer() {
    const on = document.getElementById('qbTimerEnabled').checked;
    document.getElementById('qbTimerOptions').style.display = on ? 'flex' : 'none';
}

function qbAddQuestion(data = null) {
    _qbQuestionSeq++;
    const seq = _qbQuestionSeq;
    const qid = data ? (data.id || _qbGenId()) : _qbGenId();
    const opts = data ? (data.options || ['', '', '', '']) : ['', '', '', ''];
    const correctIdx = data ? (data.correct || 0) : 0;

    const div = document.createElement('div');
    div.className = 'qb-question-row';
    div.dataset.qid = qid;

    const optRows = opts.map((opt, oi) => `
        <div class="qb-option-row">
            <input type="radio" name="correct-${qid}" value="${oi}" ${oi === correctIdx ? 'checked' : ''} title="Mark as correct">
            <span class="qb-opt-letter">${String.fromCharCode(65 + oi)}</span>
            <input type="text" class="form-control qb-opt-text" placeholder="Option ${String.fromCharCode(65 + oi)}" value="${escapeHtml(opt)}">
        </div>
    `).join('');

    div.innerHTML = `
        <div class="qb-q-header">
            <span class="qb-q-num">Question ${seq}</span>
            <button type="button" class="btn btn-light btn-sm" onclick="this.closest('.qb-question-row').remove();qbRenumber();">
                <i class="bi bi-trash"></i> Remove
            </button>
        </div>
        <div class="form-group" style="margin-bottom:10px;">
            <textarea class="form-control qb-question-text" rows="2"
                      placeholder="Enter your question here… (paste freely)"
                      style="resize:none;overflow:hidden;">${data ? escapeHtml(data.question) : ''}</textarea>
        </div>
        <div class="qb-options-wrapper">
            <div style="font-size:0.8rem;color:var(--dark-gray);margin-bottom:8px;">
                <i class="bi bi-info-circle"></i> Select the radio button next to the correct answer
            </div>
            ${optRows}
        </div>
    `;
    document.getElementById('qbQuestionsList').appendChild(div);

    // Auto-resize the textarea as the user types or pastes
    const ta = div.querySelector('.qb-question-text');
    const autoResize = () => { ta.style.height = 'auto'; ta.style.height = ta.scrollHeight + 'px'; };
    ta.addEventListener('input', autoResize);
    // Trigger once to size correctly if pre-filled
    setTimeout(autoResize, 0);
}

function qbRenumber() {
    document.querySelectorAll('#qbQuestionsList .qb-q-num').forEach((el, i) => {
        el.textContent = `Question ${i + 1}`;
    });
}

function qbOpenPastePanel() {
    const panel = document.getElementById('qbPastePanel');
    panel.style.display = 'block';
    setTimeout(() => document.getElementById('qbPasteArea').focus(), 50);
}

function qbClosePastePanel() {
    document.getElementById('qbPastePanel').style.display = 'none';
    document.getElementById('qbPasteArea').value = '';
}

function qbParsePaste() {
    const raw = document.getElementById('qbPasteArea').value;
    if (!raw.trim()) { window.showAlert('error', 'Nothing pasted yet.'); return; }

    // Split into blocks by blank lines first
    let blocks = raw.split(/\n[ \t]*\n/).map(b => b.trim()).filter(Boolean);

    // Fallback: if only 1 block, try splitting at lines that start a new numbered question
    if (blocks.length <= 1) {
        blocks = raw
            .split(/(?=^\s*(?:Q\d*[:.)]?\s+\S|\d+[.)：]\s*\S))/m)
            .map(b => b.trim()).filter(Boolean);
    }

    let added = 0;
    const failed = [];

    for (let bi = 0; bi < blocks.length; bi++) {
        const lines = blocks[bi].split('\n').map(l => l.trim()).filter(Boolean);
        if (lines.length < 3) { failed.push(bi + 1); continue; }

        // First line = question text (strip leading number/Q: prefix)
        const questionText = lines[0]
            .replace(/^\s*(?:Q\d*[:.)]?\s+|\d+[.)：]\s*)/i, '')
            .trim();
        if (!questionText) { failed.push(bi + 1); continue; }

        const options = [];
        let correctIdx = -1;

        for (let i = 1; i < lines.length; i++) {
            const line = lines[i];

            // "Answer: B" / "Ans: C" / "Correct: A" line
            const answerLineMatch = line.match(/^(?:answer|ans(?:wer)?|correct)[\s:：]+\*?([A-Fa-f])\)?\s*$/i);
            if (answerLineMatch) {
                const mk = answerLineMatch[1].toUpperCase().charCodeAt(0) - 65;
                if (mk >= 0 && mk < options.length) correctIdx = mk;
                continue;
            }

            // Option line: *A. text | A. text | A) text | (A) text | a. text | a) text
            const optMatch = line.match(/^(\*?)\(?([A-Fa-f])[.)）]\s*(.+)/);
            if (optMatch) {
                if (optMatch[1] === '*') correctIdx = options.length;
                options.push(optMatch[3].trim());
                continue;
            }

            // Option line without letter prefix (bare lines after question) — treat as choice
            // Only if we haven't started collecting lettered options yet or we already have some
            if (options.length > 0 || (i === 1 && !line.match(/^[A-Fa-f][.)）]/))) {
                // bare line starting with * = correct
                if (line.startsWith('*')) {
                    correctIdx = options.length;
                    options.push(line.slice(1).trim());
                }
            }
        }

        if (options.length < 2) { failed.push(bi + 1); continue; }
        if (correctIdx < 0 || correctIdx >= options.length) correctIdx = 0;

        qbAddQuestion({ question: questionText, options, correct: correctIdx });
        added++;
    }

    if (added === 0) {
        window.showAlert('error', "Couldn't parse any questions. Make sure each question block is separated by a blank line and options use A. B. C. format.");
        return;
    }

    const msg = added === 1 ? '1 question added!' : `${added} questions added!`;
    const warn = failed.length ? ` (${failed.length} block${failed.length > 1 ? 's' : ''} skipped)` : '';
    window.showAlert('success', msg + warn);
    qbClosePastePanel();
}

// ─── AI Generate Reviewer ────────────────────────────────────────────────────

let _aiSelectedFile = null;

function aiOpenGeneratePanel() {
    document.getElementById('aiGenerateModal').classList.add('show');
}

function aiCloseGeneratePanel() {
    document.getElementById('aiGenerateModal').classList.remove('show');
    _aiSelectedFile = null;
    const inp = document.getElementById('aiFileInput');
    if (inp) inp.value = '';
    const sel = document.getElementById('aiSelectedFile');
    if (sel) sel.style.display = 'none';
    const btn = document.getElementById('aiGenerateBtn');
    if (btn) btn.disabled = true;
}

function aiFileSelected(input) {
    const file = input.files[0];
    if (!file) return;
    _aiSelectedFile = file;
    document.getElementById('aiSelectedFileName').textContent =
        file.name + ' (' + (file.size / 1024).toFixed(0) + ' KB)';
    document.getElementById('aiSelectedFile').style.display = 'flex';
    document.getElementById('aiGenerateBtn').disabled = false;
}

async function aiDoGenerate() {
    if (!_aiSelectedFile) return;
    const btn = document.getElementById('aiGenerateBtn');
    const origHtml = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner spinner-sm"></span> Generating&hellip;';

    const wantFlashcards = document.getElementById('aiGenFlashcards')?.checked ?? true;
    const wantQuiz       = document.getElementById('aiGenQuiz')?.checked ?? false;

    try {
        const formData = new FormData();
        formData.append('file', _aiSelectedFile);
        const resp = await fetch('/api/ai/generate-reviewer', {
            method: 'POST',
            credentials: 'include',
            body: formData
        });
        const data = await resp.json();
        if (!resp.ok) {
            window.showAlert('error', data.error || 'Auto generation failed. Please try again.');
            return;
        }
        // Populate the reviewer form fields
        const titleEl = document.getElementById('reviewerTitle');
        if (titleEl) titleEl.value = data.title || '';

        if (typeof quill !== 'undefined' && quill) {
            quill.clipboard.dangerouslyPasteHTML(data.content || '');
        }

        // Populate flashcards only if user opted in
        if (wantFlashcards && Array.isArray(data.flashcards) && data.flashcards.length > 0) {
            const container = document.getElementById('flashcardsList');
            if (container) {
                container.innerHTML = '';
                data.flashcards.forEach(fc => addFlashcardRow({ front: fc.front, back: fc.back }));
            }
        }

        aiCloseGeneratePanel();

        // After saving reviewer, auto-generate quiz if opted in — store flag for after save
        if (wantQuiz) {
            window._aiPendingQuiz = true;
        }

        window.showAlert('success', 'Reviewer generated! Review and edit, then save.' + (wantQuiz ? ' Quiz will be generated after saving.' : ''), 6000);
    } catch (e) {
        console.error('Auto generate reviewer error:', e);
        window.showAlert('error', 'Auto generation failed. Please try again.');
    } finally {
        btn.disabled = false;
        btn.innerHTML = origHtml;
    }
}

// ─── AI Generate Quiz ─────────────────────────────────────────────────────────

// Silent background version: generate quiz and save straight to DB (no UI open)
// Generates and saves a quiz for the given reviewer. Returns the saved quiz object on success,
// or throws an Error on failure. No UI alerts — the caller is responsible for feedback.
async function aiGenerateAndSaveQuizInline(reviewerId) {
    const genResp = await fetch('/api/ai/generate-quiz', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reviewerId, questionCount: 100 })
    });
    const genData = await genResp.json();
    if (!genResp.ok || !Array.isArray(genData.questions) || genData.questions.length === 0) {
        throw new Error(genData.error || 'Quiz generation returned no questions');
    }

    const quiz = { timer: null, questions: genData.questions };
    const saveResp = await fetch(`/api/reviewers/${reviewerId}/quiz`, {
        method: 'PUT',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ quiz })
    });
    if (!saveResp.ok) {
        const errBody = await saveResp.json().catch(() => ({}));
        throw new Error(errBody.error || 'Failed to save quiz');
    }
    return quiz;
}

// Legacy wrapper kept for any other callers — wraps the inline version with UI alerts.
async function aiGenerateAndSaveQuizSilently(reviewerId) {
    try {
        const savedQuiz = await aiGenerateAndSaveQuizInline(reviewerId);
        window.showAlert('success', `Quiz created with ${savedQuiz.questions.length} question${savedQuiz.questions.length !== 1 ? 's' : ''}!`, 5000);
    } catch (e) {
        console.error('Silent quiz generation error:', e);
        window.showAlert('error', 'Quiz could not be auto-generated. You can create one manually from the dashboard.');
    }
}

async function aiDoGenerateQuiz() {
    if (!_qbReviewerId) {
        window.showAlert('error', 'No reviewer selected.');
        return;
    }
    const btn = document.querySelector('#qbAiPanel .btn-primary');
    const origHtml = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner spinner-sm"></span> Generating&hellip;';
    try {
        const resp = await fetch('/api/ai/generate-quiz', {
            method: 'POST',
            credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ reviewerId: _qbReviewerId })
        });
        const data = await resp.json();
        if (!resp.ok) {
            window.showAlert('error', data.error || 'Failed to generate questions. Please try again.');
            return;
        }
        data.questions.forEach(q => qbAddQuestion(q));
        document.getElementById('qbAiPanel').style.display = 'none';
        window.showAlert('success', `${data.questions.length} question${data.questions.length !== 1 ? 's' : ''} generated! Review before saving.`);
    } catch (e) {
        console.error('Auto generate quiz error:', e);
        window.showAlert('error', 'Failed to generate questions. Please try again.');
    } finally {
        btn.disabled = false;
        btn.innerHTML = origHtml;
    }
}

function qbCollect() {
    const timerOn = document.getElementById('qbTimerEnabled').checked;
    const timerMins = parseInt(document.getElementById('qbTimerMinutes').value) || 15;
    const timer = timerOn ? timerMins * 60 : null;

    const rows = document.querySelectorAll('#qbQuestionsList .qb-question-row');
    if (!rows.length) return { error: 'Add at least one question.' };

    const questions = [];
    for (const row of rows) {
        const questionText = row.querySelector('.qb-question-text').value.trim();
        if (!questionText) return { error: 'All questions must have text.' };

        const optionEls = row.querySelectorAll('.qb-opt-text');
        const options = [];
        for (const el of optionEls) {
            if (!el.value.trim()) return { error: 'All answer options must have text.' };
            options.push(el.value.trim());
        }

        const checkedRadio = row.querySelector('input[type="radio"]:checked');
        const correct = checkedRadio ? parseInt(checkedRadio.value) : 0;

        questions.push({ id: row.dataset.qid || _qbGenId(), question: questionText, options, correct });
    }

    return { quiz: { timer, questions } };
}

async function qbSave() {
    const result = qbCollect();
    if (result.error) { window.showAlert('error', result.error); return; }

    document.getElementById('qbSaveText').style.display = 'none';
    document.getElementById('qbSaveSpinner').style.display = '';

    try {
        const resp = await fetch(`/api/reviewers/${_qbReviewerId}/quiz`, {
            method: 'PUT',
            credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(result)
        });
        const data = await resp.json();
        if (!resp.ok) { window.showAlert('error', data.error || 'Failed to save quiz'); return; }

        window.showAlert('success', 'Quiz saved!');
        document.getElementById('qbDeleteBtn').style.display = '';
    } catch (e) {
        window.showAlert('error', 'Failed to save quiz');
    } finally {
        document.getElementById('qbSaveText').style.display = '';
        document.getElementById('qbSaveSpinner').style.display = 'none';
    }
}

async function qbDeleteQuiz() {
    if (!confirm('Delete this quiz? This cannot be undone.')) return;
    try {
        const resp = await fetch(`/api/reviewers/${_qbReviewerId}/quiz`, {
            method: 'DELETE', credentials: 'include'
        });
        if (!resp.ok) { const d = await resp.json(); window.showAlert('error', d.error || 'Failed'); return; }
        window.showAlert('success', 'Quiz deleted');
        closeQuizBuilder();
    } catch (e) {
        window.showAlert('error', 'Failed to delete quiz');
    }
}

document.getElementById('quizBuilderModal')?.addEventListener('click', e => {
    if (e.target.id === 'quizBuilderModal') closeQuizBuilder();
});
