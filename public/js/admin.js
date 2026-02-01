/**
 * Admin Dashboard JavaScript
 * Handles admin operations
 */

// Community Policy Violations - will be loaded dynamically from API
let COMMUNITY_POLICIES = [];

// Load policies on init
async function loadCommunityPolicies() {
    try {
        const response = await fetch('/api/policies');
        if (!response.ok) throw new Error('Failed to load policies');
        
        const policies = await response.json();
        COMMUNITY_POLICIES = policies.map(p => ({
            value: p.id.toString(),
            label: p.title,
            category: p.category
        }));
    } catch (error) {
        console.error('Error loading community policies:', error);
        // Fallback to empty array
        COMMUNITY_POLICIES = [];
    }
}

let users = [];
let reviewers = [];
let messages = [];
let currentUser = null;

document.addEventListener('DOMContentLoaded', () => {
    loadCommunityPolicies(); // Load policies first
    loadCurrentUser();
    loadAnalytics();
    loadUsers();
    loadReviewers();
    // Load moderation queue for admins
    if (typeof loadModeration === 'function') loadModeration();
    // If a hash is present (e.g. #users, #reviewers, #moderation), switch to that tab
    try {
        const hash = (location.hash || '').replace('#','');
        // support #message-moderation by mapping it to the moderation tab
        const map = {
            'users': 'users',
            'reviewers': 'reviewers',
            'moderation': 'moderation',
            'message-moderation': 'moderation'
        };
        if (hash && map[hash]) {
            // slight delay to allow initial rendering
            setTimeout(() => switchTab(map[hash]), 50);
        }
    } catch (e) { /* ignore */ }
    // Highlight the correct sidebar link on load
    try { updateSidebarActive(); } catch (e) { /* ignore */ }
    // Auto-refresh data every 30 seconds (messages removed)
    setInterval(() => {
        loadAnalytics();
        loadUsers();
        loadReviewers();
        if (typeof loadModeration === 'function') loadModeration();
    }, 30000);
});

// Delegated click handler to catch edit/delete clicks if direct handlers fail
document.addEventListener('click', (ev) => {
    const editBtn = ev.target.closest && ev.target.closest('.edit-user-btn');
    if (editBtn) {
        ev.preventDefault();
        const id = editBtn.getAttribute('data-user-id');
        console.log('Delegated edit click for', id);
        openEditUserModal(id);
        return;
    }
    const delBtn = ev.target.closest && ev.target.closest('.delete-user-btn');
    if (delBtn) {
        ev.preventDefault();
        const id = delBtn.getAttribute('data-user-id');
        console.log('Delegated delete click for', id);
        deleteUser(id);
        return;
    }
});

// Test helper: call `testOpenModal()` from the console to force the first user modal open
window.testOpenModal = () => {
    if (!users || users.length === 0) return console.warn('No users loaded');
    console.log('testOpenModal: opening for', users[0].id);
    openEditUserModal(users[0].id);
};

async function loadCurrentUser() {
    try {
        const response = await fetch('/api/auth/me', { credentials: 'include' });
        if (!response.ok) {
            window.location.href = '/login';
            return;
        }

        const data = await response.json();
        currentUser = data.user;

        // Check if user is admin
        if (currentUser.role !== 'admin') {
            await window.showModal('Access denied. Admin privileges required.', 'Access Denied');
            setTimeout(()=>{ window.location.href = '/dashboard'; }, 900);
        }
    } catch (error) {
        console.error('Error loading user:', error);
        window.location.href = '/login';
    }
}

// Update sidebar active state based on current location
function updateSidebarActive() {
    const links = Array.from(document.querySelectorAll('.sidebar-nav .sidebar-link'));
    // determine target key: users/reviewers/moderation
    let key = null;
    const p = (location.pathname || '').toLowerCase();
    if (p.includes('admin-users')) key = 'users';
    else if (p.includes('admin-reviewers')) key = 'reviewers';
    else if (p.includes('admin-message-moderation')) key = 'message-moderation';
    else if (p.includes('admin-moderation')) key = 'moderation';
    else {
        const h = (location.hash || '').replace('#','').toLowerCase();
        if (['users','reviewers','moderation','message-moderation'].includes(h)) key = h;
    }
    if (!key) key = 'users'; // default

    links.forEach(a => {
        a.classList.remove('active');
        const href = (a.getAttribute('href')||'').toLowerCase();
        if ((key === 'users' && href.includes('admin-users')) ||
            (key === 'reviewers' && href.includes('admin-reviewers')) ||
            (key === 'moderation' && href.includes('admin-moderation')) ||
            (key === 'message-moderation' && href.includes('admin-message-moderation'))) {
            a.classList.add('active');
        }
    });
}

// Recompute active when hash changes or navigation occurs
window.addEventListener('hashchange', () => { updateSidebarActive(); });
window.addEventListener('popstate', () => { updateSidebarActive(); });

// Also update active when sidebar links are clicked
document.addEventListener('click', (ev) => {
    const a = ev.target.closest && ev.target.closest('.sidebar-link');
    if (!a) return;
    // let normal navigation occur, but update active immediately for responsiveness
    setTimeout(() => updateSidebarActive(), 10);
});

// Global logout helper for pages that include admin.js (and similar admin UI)
window.logout = async function() {
    try {
        const ok = await window.showConfirm('Are you sure you want to logout?', 'Confirm');
        if (!ok) return;

        const resp = await fetch('/api/auth/logout', {
            method: 'POST',
            credentials: 'include'
        });

        if (!resp.ok) {
            console.error('Logout failed:', resp.statusText || resp.status);
            await window.showModal('Failed to log out. Please try again.', 'Error', { small: true });
            return;
        }

        window.location.href = '/login';
    } catch (error) {
        console.error('Logout error:', error);
        try { await window.showModal('An error occurred while logging out. Redirecting to login.', 'Error', { small: true }); } catch (e) {}
        window.location.href = '/login';
    }
};

async function loadAnalytics() {
    try {
        const response = await fetch('/api/admin/analytics', { credentials: 'include' });
        if (!response.ok) throw new Error('Failed to load analytics');

        const data = await response.json();
        const analytics = data.analytics;

        document.getElementById('totalUsers').textContent = analytics.total_users || 0;
        document.getElementById('totalStudents').textContent = analytics.total_students || 0;
        document.getElementById('totalAdmins').textContent = analytics.total_admins || 0;
        document.getElementById('totalSubjects').textContent = analytics.total_subjects || 0;
        document.getElementById('totalReviewers').textContent = analytics.total_reviewers || 0;
        document.getElementById('onlineUsers').textContent = analytics.current_online_users || 0;
    } catch (error) {
        console.error('Error loading analytics:', error);
    }
}

async function loadUsers() {
    try {
        const response = await fetch('/api/admin/users', { credentials: 'include' });
        if (!response.ok) throw new Error('Failed to load users');

        const data = await response.json();
        users = data.users;
        displayUsers();
    } catch (error) {
        console.error('Error loading users:', error);
        document.getElementById('usersTableBody').innerHTML = `
            <tr>
                <td colspan="6" style="text-align: center; padding: 40px; color: var(--danger);">
                    Failed to load users
                </td>
            </tr>
        `;
    }
}

function displayUsers() {
    const tbody = document.getElementById('usersTableBody');
    
    if (users.length === 0) {
        tbody.innerHTML = `
            <tr>
                <td colspan="6" style="text-align: center; padding: 40px; color: var(--dark-gray);">
                    No users found
                </td>
            </tr>
        `;
        return;
    }

    tbody.innerHTML = users.map(user => `
        <tr>
            <td><strong>${escapeHtml(user.username)}</strong></td>
            <td>${escapeHtml(user.email)}</td>
            <td>
                <span class="badge ${user.role === 'admin' ? 'badge-danger' : 'badge-primary'}">
                    ${user.role}
                </span>
            </td>
            <td>
                ${user.is_verified ? 
                    '<span class="badge badge-success">Verified</span>' : 
                    '<span class="badge" style="background: var(--warning); color: #e65100;">Unverified</span>'
                }
            </td>
            <td>${new Date(user.created_at).toLocaleDateString()}</td>
            <td>
                <div class="action-buttons">
                    <button 
                        class="btn btn-light btn-sm edit-user-btn" 
                        data-user-id="${user.id}"
                    >
                        <i class="bi bi-pencil"></i> Edit
                    </button>
                    <button 
                        class="btn btn-danger btn-sm delete-user-btn" 
                        data-user-id="${user.id}"
                        ${currentUser && user.id === currentUser.id ? 'disabled' : ''}
                    >
                        <i class="bi bi-trash"></i>
                    </button>
                </div>
            </td>
        </tr>
    `).join('');
    attachUserActionHandlers();
}

function filterUsers() {
    const searchTerm = (document.getElementById('userSearch').value || '').toLowerCase();
    const roleFilterEl = document.getElementById('roleFilter');
    const roleFilter = roleFilterEl ? (roleFilterEl.value || 'all') : 'all';

    const filtered = users.filter(user => {
        const username = (user.username || '').toLowerCase();
        const email = (user.email || '').toLowerCase();
        const displayName = (user.display_name || '').toLowerCase();
        const role = (user.role || '').toLowerCase();

        // search term matches username, email, display name, or role
        const matchesSearch = !searchTerm || username.includes(searchTerm) || email.includes(searchTerm) || displayName.includes(searchTerm) || role.includes(searchTerm);

        // role filter must match exactly unless 'all'
        const matchesRole = (roleFilter === 'all') || (role === roleFilter);

        return matchesSearch && matchesRole;
    });

    const tbody = document.getElementById('usersTableBody');
    
    if (filtered.length === 0) {
        tbody.innerHTML = `
            <tr>
                <td colspan="6" style="text-align: center; padding: 40px; color: var(--dark-gray);">
                    No users match your search
                </td>
            </tr>
        `;
        return;
    }

    tbody.innerHTML = filtered.map(user => `
        <tr>
            <td><strong>${escapeHtml(user.username)}</strong></td>
            <td>${escapeHtml(user.email)}</td>
            <td>
                <span class="badge ${user.role === 'admin' ? 'badge-danger' : 'badge-primary'}">
                    ${user.role}
                </span>
            </td>
            <td>
                ${user.is_verified ? 
                    '<span class="badge badge-success">Verified</span>' : 
                    '<span class="badge" style="background: var(--warning); color: #e65100;">Unverified</span>'
                }
            </td>
            <td>${new Date(user.created_at).toLocaleDateString()}</td>
            <td>
                <div class="action-buttons">
                    <button 
                        class="btn btn-light btn-sm edit-user-btn" 
                        data-user-id="${user.id}"
                        ${currentUser && user.id === currentUser.id ? 'disabled' : ''}
                    >
                        <i class="bi bi-pencil"></i> Edit
                    </button>
                    <button 
                        class="btn btn-danger btn-sm delete-user-btn" 
                        data-user-id="${user.id}"
                        ${currentUser && user.id === currentUser.id ? 'disabled' : ''}
                    >
                        <i class="bi bi-trash"></i>
                    </button>
                </div>
            </td>
        </tr>
    `).join('');
    attachUserActionHandlers();
}

function attachUserActionHandlers() {
    // Edit buttons
    document.querySelectorAll('.edit-user-btn').forEach(btn => {
        btn.onclick = (ev) => {
            ev.preventDefault();
            const id = btn.getAttribute('data-user-id');
            openEditUserModal(id);
        };
    });

    // Delete buttons
    document.querySelectorAll('.delete-user-btn').forEach(btn => {
        btn.onclick = (ev) => {
            ev.preventDefault();
            const id = btn.getAttribute('data-user-id');
            deleteUser(id);
        };
    });
}

async function toggleUserRole(userId, currentRole) {
    // Prompt admin to choose new role
    const choice = await window.showPrompt('Enter new role (admin, moderator, student):', 'Set User Role', { defaultValue: currentRole });
    if (!choice) return;
    const newRole = choice.trim().toLowerCase();
    if (!['admin','moderator','student'].includes(newRole)) {
        await window.showModal('Invalid role selected', 'Error');
        return;
    }
    if (!(await window.showConfirm(`Change user role from ${currentRole} to ${newRole}?`, 'Confirm Role Change'))) return;

    try {
        const response = await fetch(`/api/admin/users/${userId}/role`, {
            method: 'PUT',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ role: newRole })
        });

        if (!response.ok) throw new Error('Failed to update role');

        await loadUsers();
        await loadAnalytics();
        await window.showModal('User role updated successfully', 'Success');
    } catch (error) {
        console.error('Error updating role:', error);
        await window.showModal('Failed to update user role', 'Error');
    }
}

async function deleteUser(userId) {
    if (!(await window.showConfirm('Are you sure you want to delete this user? This will also delete all their subjects and reviewers.', 'Confirm Delete'))) {
        return;
    }

    try {
        const response = await fetch(`/api/admin/users/${userId}`, {
            method: 'DELETE'
        });

        if (!response.ok) throw new Error('Failed to delete user');

        await loadUsers();
        await loadAnalytics();
        await window.showModal('User deleted successfully', 'Success');
    } catch (error) {
        console.error('Error deleting user:', error);
        await window.showModal('Failed to delete user', 'Error');
    }
}

async function loadReviewers() {
    try {
        const response = await fetch('/api/admin/reviewers');
        if (!response.ok) throw new Error('Failed to load reviewers');

        const data = await response.json();
        reviewers = data.reviewers;
        displayReviewers();
    } catch (error) {
        console.error('Error loading reviewers:', error);
        document.getElementById('reviewersTableBody').innerHTML = `
            <tr>
                <td colspan="6" style="text-align: center; padding: 40px; color: var(--danger);">
                    Failed to load reviewers
                </td>
            </tr>
        `;
    }
}

// Load moderation reports for admin
async function loadModeration() {
    try {
        const resp = await fetch('/api/admin/moderation', { credentials: 'include' });
        if (!resp.ok) throw new Error('Failed to load moderation');
        const data = await resp.json();
        // Determine scope from hash: 'message-moderation' => message reports only, default => reviewer reports
        const hash = (location.hash || '').replace('#','').toLowerCase();
        const scope = (hash === 'message-moderation') ? 'message' : 'reviewer';
        // update moderation header title to reflect selected scope
        try {
            const hdr = document.querySelector('#moderationTab .table-header h3');
            if (hdr) hdr.textContent = scope === 'message' ? 'Message Moderation' : 'Reviewer Moderation';
        } catch (e) {}
        displayModeration(data.reports || [], scope);
    } catch (e) {
        console.error('Error loading moderation:', e);
        const tbody = document.getElementById('moderationTableBody');
        if (tbody) tbody.innerHTML = `<tr><td colspan="6" style="text-align:center;padding:20px;color:var(--danger);">Failed to load reports</td></tr>`;
    }
}

function displayModeration(reports, scope = 'reviewer') {
    const tbody = document.getElementById('moderationTableBody');
    if (!tbody) return;
    
    // Update table headers based on scope
    const headerRow = document.querySelector('#moderationTableBody')?.closest('table')?.querySelector('thead tr');
    if (headerRow) {
        if (scope === 'message') {
            headerRow.innerHTML = `
                <th>Reported User</th>
                <th>Reporter</th>
                <th>Violation Type</th>
                <th>Message</th>
                <th>Created</th>
                <th>Action</th>
            `;
        } else {
            headerRow.innerHTML = `
                <th>Reported User</th>
                <th>Reporter</th>
                <th>Violation Type</th>
                <th>Reviewer</th>
                <th>Created</th>
                <th>Action</th>
            `;
        }
    }
    
    // Filter out already resolved or dismissed reports as a defensive client-side check
    let openReports = (reports || []).filter(r => !r.status || r.status === 'open');
    // Filter by requested scope
    if (scope === 'message') {
        openReports = openReports.filter(r => (r.type === 'chat') || (!!r.message));
    } else {
        openReports = openReports.filter(r => !(r.type === 'chat') && !r.message);
    }
    if (!openReports || openReports.length === 0) {
        tbody.innerHTML = `<tr><td colspan="6" style="text-align:center;padding:20px;color:var(--dark-gray);">No reports found</td></tr>`;
        return;
    }

    tbody.innerHTML = openReports.map(r => {
        if (r.type === 'chat' || r.message) {
            const msg = r.message || {};
            const reportedUserName = msg.username || 'Unknown User';
            const reportedUserId = msg.user_id || msg.userId || '';
            const userLink = reportedUserId ? `<a href="/user.html?user=${encodeURIComponent(reportedUserId)}" target="_blank" style="color:var(--primary-pink);font-weight:500;">${escapeHtml(reportedUserName)}</a>` : `<strong>${escapeHtml(reportedUserName)}</strong>`;
            const viewLink = msg.id ? `<a href="/chat.html?scrollTo=${encodeURIComponent(msg.id)}" target="_blank" style="color:var(--primary-pink);font-weight:500;">View message</a>` : '';
            return `
        <tr>
            <td>${userLink}</td>
            <td>${escapeHtml(r.reporter?.username || 'Anonymous')}</td>
            <td><span class="badge badge-warning">${escapeHtml(r.report_type || 'unspecified')}</span></td>
            <td style="max-width:300px;">${viewLink}</td>
            <td style="white-space:nowrap;">${new Date(r.created_at).toLocaleString()}</td>
            <td>
                <div class="action-buttons">
                    <button class="btn btn-warning btn-sm" onclick="openMessageActionModal('${r.id}')">Take Action</button>
                    <button class="btn btn-light btn-sm" onclick="dismissReport('${r.id}')">Dismiss</button>
                </div>
            </td>
        </tr>
        `;
        }
        // reviewer report - show reported user and reviewer link in separate columns
        const reportedUserName = r.reviewers?.users?.username || r.reviewers?.user_username || 'Unknown User';
        const reportedUserId = r.reviewers?.users?.id || r.reviewers?.user_id || '';
        const reportedUserLink = reportedUserId ? `<a href="/user.html?user=${encodeURIComponent(reportedUserId)}" target="_blank" style="color:var(--primary-pink);font-weight:500;">${escapeHtml(reportedUserName)}</a>` : `<strong>${escapeHtml(reportedUserName)}</strong>`;
        const reviewerTitle = r.reviewers?.title || 'Untitled Reviewer';
        const reviewerId = r.reviewers?.id || r.reviewer_id;
        const reviewerLink = reviewerId ? `<a href="/index.html?reviewer=${encodeURIComponent(reviewerId)}" target="_blank" style="color:var(--primary-pink);font-weight:500;" onclick="event.preventDefault(); window.open('/index.html?reviewer=${encodeURIComponent(reviewerId)}', '_blank'); return false;">${escapeHtml(reviewerTitle)}</a>` : escapeHtml(reviewerTitle);
        return `
        <tr>
            <td>${reportedUserLink}</td>
            <td>${escapeHtml(r.reporter?.username || '')}</td>
            <td>${escapeHtml(r.report_type || '')}</td>
            <td style="max-width:280px;">${reviewerLink}</td>
            <td>${new Date(r.created_at).toLocaleString()}</td>
            <td>
                <div class="action-buttons">
                    <button class="btn btn-warning btn-sm" onclick="openReviewerActionModal('${r.id}')">Take Action</button>
                    <button class="btn btn-light btn-sm" onclick="dismissReport('${r.id}')">Dismiss</button>
                </div>
            </td>
        </tr>
        `;
    }).join('');
}

// Global function to open reviewer modal from moderation table
window.openReviewerModal = async function(reviewerId) {
    try {
        const resp = await fetch(`/api/reviewers/${reviewerId}`, { credentials: 'include' });
        if (!resp.ok) {
            await window.showModal('Reviewer not found or not accessible', 'Error');
            return;
        }
        const data = await resp.json();
        const reviewer = data.reviewer;
        
        // Create modal
        const existing = document.getElementById('reviewerViewModal');
        if (existing) existing.remove();
        
        const modal = document.createElement('div');
        modal.id = 'reviewerViewModal';
        modal.className = 'modal';
        modal.style.display = 'flex';
        modal.style.zIndex = 8000;
        
        modal.innerHTML = `
            <div class="modal-content" style="max-width:800px;max-height:90vh;overflow-y:auto;">
                <div class="modal-header">
                    <h3 class="modal-title">${escapeHtml(reviewer.title || 'Reviewer')}</h3>
                    <button class="modal-close" id="reviewerViewClose">&times;</button>
                </div>
                <div class="modal-body" style="padding:24px;">
                    <div style="margin-bottom:16px;">
                        <strong style="color:var(--dark-gray);">Content:</strong>
                        <div style="margin-top:8px;padding:16px;background:#fafafa;border-radius:8px;white-space:pre-wrap;">${escapeHtml(reviewer.content || 'No content')}</div>
                    </div>
                    ${reviewer.flashcards && reviewer.flashcards.length > 0 ? `
                        <div style="margin-top:20px;">
                            <strong style="color:var(--dark-gray);">Flashcards (${reviewer.flashcards.length}):</strong>
                            <div style="margin-top:8px;">${reviewer.flashcards.map((fc, idx) => `
                                <div style="padding:12px;margin-top:8px;background:#fff;border:1px solid #e0e0e0;border-radius:6px;">
                                    <div style="font-weight:600;color:var(--primary-pink);">Card ${idx + 1}</div>
                                    <div style="margin-top:6px;"><strong>Front:</strong> ${escapeHtml(fc.front || fc.meaning || '')}</div>
                                    <div style="margin-top:4px;"><strong>Back:</strong> ${escapeHtml(fc.back || fc.content || '')}</div>
                                </div>
                            `).join('')}</div>
                        </div>
                    ` : ''}
                </div>
                <div class="modal-footer">
                    <button class="btn btn-light" id="reviewerViewCloseBtn">Close</button>
                </div>
            </div>
        `;
        
        document.body.appendChild(modal);
        
        const close = () => { try { modal.remove(); } catch(e) {} };
        document.getElementById('reviewerViewClose').onclick = close;
        document.getElementById('reviewerViewCloseBtn').onclick = close;
        modal.onclick = (e) => { if (e.target === modal) close(); };
        
    } catch (error) {
        console.error('Error opening reviewer modal:', error);
        await window.showModal('Failed to load reviewer content', 'Error');
    }
};

// Professional modal for message report actions
window.openMessageActionModal = function(reportId) {
    const existing = document.getElementById('messageActionModal');
    if (existing) existing.remove();
    const div = document.createElement('div');
    div.id = 'messageActionModal';
    div.className = 'modal';
    div.style.display = 'flex';
    div.style.zIndex = 7000;
    div.innerHTML = `
        <div class="modal-content" style="max-width:700px;">
            <div class="modal-header">
                <h3 class="modal-title"><i class="bi bi-chat-square-text-fill"></i> Message Moderation Action</h3>
                <button class="modal-close" id="msgActionClose">&times;</button>
            </div>
            <div class="modal-body" style="padding:24px;">
                <p style="margin-bottom:20px;color:var(--dark-gray);font-size:14px;">Select the appropriate action for this reported chat message:</p>
                
                <div style="margin-bottom:20px;">
                    <label style="font-weight:600;margin-bottom:12px;display:block;color:var(--text-dark);">Message Action</label>
                    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px;">
                        <label style="padding:14px;border:2px solid var(--medium-gray);border-radius:10px;cursor:pointer;transition:all 0.2s;" class="action-type-label">
                            <input type="radio" name="msgActionType" value="delete_message" checked style="margin-right:8px;">
                            <div><strong style="color:var(--text-dark);">Delete Message</strong></div>
                            <small style="color:var(--dark-gray);line-height:1.4;">Remove the message from chat</small>
                        </label>
                        <label style="padding:14px;border:2px solid var(--medium-gray);border-radius:10px;cursor:pointer;transition:all 0.2s;" class="action-type-label">
                            <input type="radio" name="msgActionType" value="mute_user" style="margin-right:8px;">
                            <div><strong style="color:var(--text-dark);">Mute User</strong></div>
                            <small style="color:var(--dark-gray);line-height:1.4;">Temporarily prevent from sending chat messages</small>
                        </label>
                        <label style="padding:14px;border:2px solid var(--medium-gray);border-radius:10px;cursor:pointer;transition:all 0.2s;" class="action-type-label">
                            <input type="radio" name="msgActionType" value="ban_user" style="margin-right:8px;">
                            <div><strong style="color:var(--text-dark);">Ban Account</strong></div>
                            <small style="color:var(--dark-gray);line-height:1.4;">Ban user from entire platform</small>
                        </label>
                        <label style="padding:14px;border:2px solid var(--medium-gray);border-radius:10px;cursor:pointer;transition:all 0.2s;" class="action-type-label">
                            <input type="radio" name="msgActionType" value="warn_user" style="margin-right:8px;">
                            <div><strong style="color:var(--text-dark);">Send Warning</strong></div>
                            <small style="color:var(--dark-gray);line-height:1.4;">Notify user of violation</small>
                        </label>
                    </div>
                </div>

                <div id="msgDurationSection" style="margin-bottom:20px;display:none;">
                    <label style="font-weight:600;margin-bottom:8px;display:block;color:var(--text-dark);">Restriction Duration</label>
                    <select id="msgDuration" class="form-control" style="max-width:280px;">
                        <option value="30m">30 minutes</option>
                        <option value="1h" selected>1 hour</option>
                        <option value="3h">3 hours</option>
                        <option value="6h">6 hours</option>
                        <option value="12h">12 hours</option>
                        <option value="1d">1 day</option>
                        <option value="3d">3 days</option>
                        <option value="1w">1 week</option>
                        <option value="2w">2 weeks</option>
                        <option value="1m">1 month</option>
                        <option value="permanent">Permanent</option>
                    </select>
                </div>

                <div style="margin-bottom:20px;">
                    <label style="font-weight:600;margin-bottom:8px;display:block;color:var(--text-dark);">Policy Violation</label>
                    <select id="msgPolicyViolation" class="form-control" style="margin-bottom:12px;">
                        <option value="">Select policy violation...</option>
                        ${COMMUNITY_POLICIES.filter(p => p.category === 'message' || p.category === 'both').map(p => 
                            `<option value="${p.value}">${p.label}</option>`
                        ).join('')}
                    </select>
                </div>

                <div style="margin-bottom:20px;">
                    <label style="font-weight:600;margin-bottom:8px;display:block;color:var(--text-dark);">Additional Notes (Optional)</label>
                    <textarea id="msgActionNote" class="form-control" placeholder="Specify the violation and reason for this action..." style="width:100%;height:90px;resize:vertical;font-size:14px;"></textarea>
                    <small style="color:var(--dark-gray);font-size:12px;">This will be logged in the moderation history</small>
                </div>

                <div style="padding:14px;background:#fff3cd;border-radius:8px;border-left:4px solid #ffc107;">
                    <div style="display:flex;align-items:start;gap:10px;">
                        <i class="bi bi-info-circle-fill" style="color:#856404;font-size:18px;margin-top:2px;"></i>
                        <small style="color:#856404;line-height:1.5;"><strong>Action Details:</strong> Delete Message removes content only. Mute prevents chat messages temporarily. Ban restricts entire account access.</small>
                    </div>
                </div>
            </div>
            <div class="modal-footer">
                <button class="btn btn-light" id="msgActionCancel">Cancel</button>
                <button class="btn btn-danger" id="msgActionSubmit" style="min-width:140px;"><i class="bi bi-shield-fill-check"></i> Execute Action</button>
            </div>
        </div>`;
    document.body.appendChild(div);

    const labels = div.querySelectorAll('.action-type-label');
    const updateLabels = () => {
        labels.forEach(l => {
            const input = l.querySelector('input');
            if (input.checked) {
                l.style.borderColor = 'var(--primary-pink)';
                l.style.background = 'var(--secondary-pink)';
                l.style.transform = 'scale(1.02)';
            } else {
                l.style.borderColor = 'var(--medium-gray)';
                l.style.background = 'white';
                l.style.transform = 'scale(1)';
            }
        });
        const actionType = div.querySelector('input[name="msgActionType"]:checked').value;
        const durationSection = document.getElementById('msgDurationSection');
        durationSection.style.display = (actionType === 'mute_user' || actionType === 'ban_user') ? 'block' : 'none';
    };
    div.querySelectorAll('input[name="msgActionType"]').forEach(r => r.addEventListener('change', updateLabels));
    updateLabels();

    const close = () => { try{ div.remove(); }catch(e){} };
    document.getElementById('msgActionClose').onclick = close;
    document.getElementById('msgActionCancel').onclick = close;

    document.getElementById('msgActionSubmit').onclick = async () => {
        const actionType = div.querySelector('input[name="msgActionType"]:checked').value;
        const duration = document.getElementById('msgDuration').value;
        const policyViolation = document.getElementById('msgPolicyViolation').value;
        const additionalNotes = document.getElementById('msgActionNote').value.trim();
        
        if (!policyViolation) {
            await window.showModal('Please select the policy violation.', 'Policy Required');
            return;
        }

        const policyLabel = COMMUNITY_POLICIES.find(p => p.value === policyViolation)?.label || policyViolation;
        const note = policyLabel + (additionalNotes ? ` - ${additionalNotes}` : '');

        let confirmMsg = '';
        if (actionType === 'delete_message') confirmMsg = 'Delete this message from the chat?';
        else if (actionType === 'mute_user') confirmMsg = 'Temporarily mute this user from sending chat messages?';
        else if (actionType === 'ban_user') confirmMsg = 'Ban this user account from the entire platform?';
        else if (actionType === 'warn_user') confirmMsg = 'Send a warning to this user?';
        
        if (!await window.showConfirm(confirmMsg, 'Confirm Moderation Action')) return;
        
        if (actionType === 'warn_user') {
            await adminTakeAction(reportId, 'warn_message', { note });
        } else if (actionType === 'delete_message') {
            await adminTakeAction(reportId, 'delete_message', { note });
        } else {
            const until = computeUntilFromDuration(duration);
            const action = actionType === 'mute_user' ? 'mute' : 'ban_chat';
            await adminTakeAction(reportId, action, { until, note });
        }
        close();
    };
};

// Professional modal for reviewer report actions
window.openReviewerActionModal = function(reportId) {
    const existing = document.getElementById('reviewerActionModal');
    if (existing) existing.remove();
    const div = document.createElement('div');
    div.id = 'reviewerActionModal';
    div.className = 'modal';
    div.style.display = 'flex';
    div.style.zIndex = 7000;
    div.innerHTML = `
        <div class="modal-content" style="max-width:700px;">
            <div class="modal-header">
                <h3 class="modal-title"><i class="bi bi-journal-text"></i> Reviewer Content Moderation</h3>
                <button class="modal-close" id="revActionClose">&times;</button>
            </div>
            <div class="modal-body" style="padding:24px;">
                <p style="margin-bottom:20px;color:var(--dark-gray);font-size:14px;">Select the appropriate action for this reported reviewer content:</p>
                
                <div style="margin-bottom:20px;">
                    <label style="font-weight:600;margin-bottom:12px;display:block;color:var(--text-dark);">Content Action</label>
                    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px;">
                        <label style="padding:14px;border:2px solid var(--medium-gray);border-radius:10px;cursor:pointer;transition:all 0.2s;" class="rev-action-label">
                            <input type="radio" name="revActionType" value="hide_reviewer" checked style="margin-right:8px;">
                            <div><strong style="color:var(--text-dark);">Hide Reviewer</strong></div>
                            <small style="color:var(--dark-gray);line-height:1.4;">Make private temporarily</small>
                        </label>
                        <label style="padding:14px;border:2px solid var(--medium-gray);border-radius:10px;cursor:pointer;transition:all 0.2s;" class="rev-action-label">
                            <input type="radio" name="revActionType" value="delete_reviewer" style="margin-right:8px;">
                            <div><strong style="color:var(--text-dark);">Delete Reviewer</strong></div>
                            <small style="color:var(--dark-gray);line-height:1.4;">Permanently remove content</small>
                        </label>
                        <label style="padding:14px;border:2px solid var(--medium-gray);border-radius:10px;cursor:pointer;transition:all 0.2s;" class="rev-action-label">
                            <input type="radio" name="revActionType" value="suspend_author" style="margin-right:8px;">
                            <div><strong style="color:var(--text-dark);">Suspend Author</strong></div>
                            <small style="color:var(--dark-gray);line-height:1.4;">Block from creating content</small>
                        </label>
                        <label style="padding:14px;border:2px solid var(--medium-gray);border-radius:10px;cursor:pointer;transition:all 0.2s;" class="rev-action-label">
                            <input type="radio" name="revActionType" value="warn_author" style="margin-right:8px;">
                            <div><strong style="color:var(--text-dark);">Issue Warning</strong></div>
                            <small style="color:var(--dark-gray);line-height:1.4;">Notify author of violation</small>
                        </label>
                    </div>
                </div>

                <div id="revDurationSection" style="margin-bottom:20px;display:none;">
                    <label style="font-weight:600;margin-bottom:8px;display:block;color:var(--text-dark);">Suspension Duration</label>
                    <select id="revDuration" class="form-control" style="max-width:280px;">
                        <option value="1d">1 day</option>
                        <option value="3d">3 days</option>
                        <option value="1w" selected>1 week</option>
                        <option value="2w">2 weeks</option>
                        <option value="1m">1 month</option>
                        <option value="3m">3 months</option>
                        <option value="6m">6 months</option>
                        <option value="permanent">Permanent</option>
                    </select>
                </div>

                <div style="margin-bottom:20px;">
                    <label style="font-weight:600;margin-bottom:8px;display:block;color:var(--text-dark);">Policy Violation</label>
                    <select id="revPolicyViolation" class="form-control" style="margin-bottom:12px;">
                        <option value="">Select policy violation...</option>
                        ${COMMUNITY_POLICIES.filter(p => p.category === 'reviewer' || p.category === 'both').map(p => 
                            `<option value="${p.value}">${p.label}</option>`
                        ).join('')}
                    </select>
                </div>

                <div style="margin-bottom:20px;">
                    <label style="font-weight:600;margin-bottom:8px;display:block;color:var(--text-dark);">Additional Notes (Optional)</label>
                    <textarea id="revActionNote" class="form-control" placeholder="Describe the policy violation and justification for this action..." style="width:100%;height:90px;resize:vertical;font-size:14px;"></textarea>
                    <small style="color:var(--dark-gray);font-size:12px;">This will be recorded in the content moderation log</small>
                </div>

                <div style="padding:14px;background:#e7f3ff;border-radius:8px;border-left:4px solid #0066cc;">
                    <div style="display:flex;align-items:start;gap:10px;">
                        <i class="bi bi-lightbulb-fill" style="color:#0066cc;font-size:18px;margin-top:2px;"></i>
                        <small style="color:#004085;line-height:1.5;"><strong>Content Actions:</strong> Hide temporarily removes visibility. Delete permanently removes content. Suspend prevents author from creating new reviewers.</small>
                    </div>
                </div>
            </div>
            <div class="modal-footer">
                <button class="btn btn-light" id="revActionCancel">Cancel</button>
                <button class="btn btn-primary" id="revActionSubmit" style="min-width:140px;"><i class="bi bi-shield-fill-check"></i> Execute Action</button>
            </div>
        </div>`;
    document.body.appendChild(div);

    const labels = div.querySelectorAll('.rev-action-label');
    const updateLabels = () => {
        labels.forEach(l => {
            const input = l.querySelector('input');
            if (input.checked) {
                l.style.borderColor = 'var(--primary-pink)';
                l.style.background = 'var(--secondary-pink)';
                l.style.transform = 'scale(1.02)';
            } else {
                l.style.borderColor = 'var(--medium-gray)';
                l.style.background = 'white';
                l.style.transform = 'scale(1)';
            }
        });
        const actionType = div.querySelector('input[name="revActionType"]:checked').value;
        const durationSection = document.getElementById('revDurationSection');
        durationSection.style.display = (actionType === 'suspend_author' || actionType === 'hide_reviewer') ? 'block' : 'none';
    };
    div.querySelectorAll('input[name="revActionType"]').forEach(r => r.addEventListener('change', updateLabels));
    updateLabels();

    const close = () => { try{ div.remove(); }catch(e){} };
    document.getElementById('revActionClose').onclick = close;
    document.getElementById('revActionCancel').onclick = close;

    document.getElementById('revActionSubmit').onclick = async () => {
        const actionType = div.querySelector('input[name="revActionType"]:checked').value;
        const duration = document.getElementById('revDuration').value;
        const policyViolation = document.getElementById('revPolicyViolation').value;
        const additionalNotes = document.getElementById('revActionNote').value.trim();
        
        if (!policyViolation) {
            await window.showModal('Please select the policy violation.', 'Policy Required');
            return;
        }

        const policyLabel = COMMUNITY_POLICIES.find(p => p.value === policyViolation)?.label || policyViolation;
        const note = policyLabel + (additionalNotes ? ` - ${additionalNotes}` : '');

        let confirmMsg = '';
        if (actionType === 'delete_reviewer') confirmMsg = 'Permanently delete this reviewer content? This cannot be undone.';
        else if (actionType === 'hide_reviewer') confirmMsg = 'Hide this reviewer from public view?';
        else if (actionType === 'suspend_author') confirmMsg = 'Suspend this author from creating new reviewer content?';
        else if (actionType === 'warn_author') confirmMsg = 'Send a policy violation warning to this author?';
        
        if (!await window.showConfirm(confirmMsg, 'Confirm Content Moderation')) return;
        
        if (actionType === 'warn_author') {
            await adminTakeAction(reportId, 'warn_reviewer', { note });
        } else if (actionType === 'delete_reviewer') {
            await adminTakeAction(reportId, 'delete_content', { note });
        } else if (actionType === 'hide_reviewer') {
            const until = computeUntilFromDuration(duration);
            await adminTakeAction(reportId, 'hide_content', { until, note });
        } else if (actionType === 'suspend_author') {
            const until = computeUntilFromDuration(duration);
            await adminTakeAction(reportId, 'suspend_author', { until, note });
        }
        close();
    };
};

// Dismiss report without action
window.dismissReport = async function(reportId) {
    if (!await window.showConfirm('Mark this report as reviewed without taking action?', 'Dismiss Report')) return;
    await adminTakeAction(reportId, 'dismiss', {});
};

function computeUntilFromDuration(duration) {
    if (!duration) return null;
    const now = new Date();
    if (duration === 'permanent') {
        const far = new Date(); far.setFullYear(far.getFullYear() + 100);
        return far.toISOString();
    }
    if (duration.endsWith('h')) {
        const hrs = parseInt(duration.replace('h',''),10);
        now.setHours(now.getHours() + hrs);
        return now.toISOString();
    }
    if (duration.endsWith('d')) {
        const days = parseInt(duration.replace('d',''),10);
        now.setDate(now.getDate() + days);
        return now.toISOString();
    }
    if (duration.endsWith('w')) {
        const weeks = parseInt(duration.replace('w',''),10);
        now.setDate(now.getDate() + weeks * 7);
        return now.toISOString();
    }
    if (duration.endsWith('m')) {
        const num = parseInt(duration.replace('m',''),10);
        // Distinguish minutes (30m) from months (1m, 3m, 6m)
        // Minutes are typically 30 or less, months are for longer durations
        if (num >= 30 && num < 100) {
            // Minutes (e.g., 30m)
            now.setMinutes(now.getMinutes() + num);
        } else {
            // Months (e.g., 1m, 3m, 6m)
            now.setMonth(now.getMonth() + num);
        }
        return now.toISOString();
    }
    return null;
}

async function adminTakeAction(reportId, action, opts = {}) {
    // opts may include { until: ISO|null, note: string }
    if (!(await window.showConfirm('Are you sure you want to perform this action?', 'Confirm Action'))) return;
    let until = null;
    if (opts && Object.prototype.hasOwnProperty.call(opts, 'until')) {
        until = opts.until;
    } else {
        if (action === 'ban' || action === 'restrict') {
            const val = await window.showPrompt('Enter until date/time (ISO) or leave blank for indefinite (e.g. 2026-02-15T00:00:00Z):', 'Set Until', {placeholder:'2026-02-15T00:00:00Z', defaultValue:''});
            until = val || null;
        }
    }
    let note = '';
    if (opts && Object.prototype.hasOwnProperty.call(opts, 'note')) {
        note = opts.note || '';
    } else {
        note = (await window.showPrompt('Optional note about the action:', 'Action Note', {placeholder:'Note', defaultValue:''})) || '';
    }
    try {
        const resp = await fetch(`/api/admin/moderation/${encodeURIComponent(reportId)}/action`, {
            method: 'PUT',
            credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action, until, note })
        });
        if (!resp.ok) {
            const j = await resp.json().catch(()=>null);
            await window.showModal((j && j.error) ? j.error : 'Failed to perform action', 'Error');
            return;
        }
        await window.showModal('Action performed', 'Success');

        // If the action deletes content or messages, ensure the resource is removed from DB (best-effort)
        try {
            if (action === 'delete_message' || action === 'delete_content') {
                // Fetch moderation list to locate the report and referenced resource id
                const mresp = await fetch('/api/admin/moderation', { credentials: 'include' });
                if (mresp.ok) {
                    const mdata = await mresp.json().catch(()=>null);
                    const reports = (mdata && mdata.reports) ? mdata.reports : mdata || [];
                    const found = (reports || []).find(r => String(r.id) === String(reportId));
                    if (found) {
                        // chat report
                        if (found.type === 'chat' || found.message) {
                            const msgId = (found.message && (found.message.id || found.message_id)) || found.message_id || (found.message && found.message.id);
                            if (msgId) {
                                try {
                                    await fetch(`/api/admin/messages/${encodeURIComponent(msgId)}`, { method: 'DELETE', credentials: 'include' });
                                } catch (e) { /* ignore */ }
                            }
                        } else {
                            // reviewer report
                            const reviewerId = (found.reviewers && (found.reviewers.id || found.reviewer_id)) || found.reviewer_id;
                            if (reviewerId) {
                                try {
                                    await fetch(`/api/admin/reviewers/${encodeURIComponent(reviewerId)}`, { method: 'DELETE', credentials: 'include' });
                                } catch (e) { /* ignore */ }
                            }
                        }
                    }
                }
            }
        } catch (e) {
            console.warn('Post-action cleanup failed', e);
        }

        await loadModeration();
        await loadUsers();
    } catch (e) {
        console.error('Admin action failed', e);
        await window.showModal('Failed to perform admin action', 'Error');
    }
}

function displayReviewers() {
    const tbody = document.getElementById('reviewersTableBody');
    
    if (reviewers.length === 0) {
        tbody.innerHTML = `
            <tr>
                <td colspan="6" style="text-align: center; padding: 40px; color: var(--dark-gray);">
                    No reviewers found
                </td>
            </tr>
        `;
        return;
    }

    tbody.innerHTML = reviewers.map(reviewer => `
        <tr>
            <td><strong>${escapeHtml(reviewer.title)}</strong></td>
            <td>${escapeHtml(reviewer.subjects?.name || 'Unknown')}</td>
            <td>${escapeHtml(reviewer.users?.username || 'Unknown')}</td>
            <td>
                ${reviewer.is_public ? 
                    '<span class="badge badge-success">Public</span>' : 
                    '<span class="badge badge-primary">Private</span>'
                }
            </td>
            <td>${new Date(reviewer.created_at).toLocaleDateString()}</td>
            <td>
                <div class="action-buttons">
                    <button 
                        class="btn btn-danger btn-sm" 
                        onclick="deleteReviewer('${reviewer.id}')"
                    >
                        <i class="bi bi-trash"></i> Delete
                    </button>
                </div>
            </td>
        </tr>
    `).join('');
}

function filterReviewers() {
    const searchTerm = document.getElementById('reviewerSearch').value.toLowerCase();
    const filtered = reviewers.filter(reviewer => 
        reviewer.title.toLowerCase().includes(searchTerm) ||
        (reviewer.subjects?.name || '').toLowerCase().includes(searchTerm) ||
        (reviewer.users?.username || '').toLowerCase().includes(searchTerm) ||
        (reviewer.users?.display_name || '').toLowerCase().includes(searchTerm)
    );

    const tbody = document.getElementById('reviewersTableBody');
    
    if (filtered.length === 0) {
        tbody.innerHTML = `
            <tr>
                <td colspan="6" style="text-align: center; padding: 40px; color: var(--dark-gray);">
                    No reviewers match your search
                </td>
            </tr>
        `;
        return;
    }

    tbody.innerHTML = filtered.map(reviewer => `
        <tr>
            <td><strong>${escapeHtml(reviewer.title)}</strong></td>
            <td>${escapeHtml(reviewer.subjects?.name || 'Unknown')}</td>
            <td>${escapeHtml(reviewer.users?.username || 'Unknown')}</td>
            <td>
                ${reviewer.is_public ? 
                    '<span class="badge badge-success">Public</span>' : 
                    '<span class="badge badge-primary">Private</span>'
                }
            </td>
            <td>${new Date(reviewer.created_at).toLocaleDateString()}</td>
            <td>
                <div class="action-buttons">
                    <button 
                        class="btn btn-danger btn-sm" 
                        onclick="deleteReviewer('${reviewer.id}')"
                    >
                        <i class="bi bi-trash"></i> Delete
                    </button>
                </div>
            </td>
        </tr>
    `).join('');
}

async function deleteReviewer(reviewerId) {
    if (!(await window.showConfirm('Are you sure you want to delete this reviewer?', 'Confirm Delete'))) {
        return;
    }

    try {
        const response = await fetch(`/api/admin/reviewers/${reviewerId}`, {
            method: 'DELETE'
        });

        if (!response.ok) throw new Error('Failed to delete reviewer');

        await loadReviewers();
        await loadAnalytics();
        await window.showModal('Reviewer deleted successfully', 'Success');
    } catch (error) {
        console.error('Error deleting reviewer:', error);
        await window.showModal('Failed to delete reviewer', 'Error');
    }
}

async function loadMessages() {
    // messages feature removed from admin; function retained as noop for safety
    return;
}

function displayMessages() {
    const tbody = document.getElementById('messagesTableBody');
    
    if (messages.length === 0) {
        tbody.innerHTML = `
            <tr>
                <td colspan="5" style="text-align: center; padding: 40px; color: var(--dark-gray);">
                    No messages found
                </td>
            </tr>
        `;
        return;
    }

    tbody.innerHTML = messages.map(msg => `
        <tr>
            <td><strong>${escapeHtml(msg.username)}</strong></td>
            <td>${escapeHtml(msg.message)}</td>
            <td>
                <span class="badge badge-info">${msg.chat_type}</span>
            </td>
            <td>${new Date(msg.created_at).toLocaleString()}</td>
            <td>
                <button 
                    class="btn btn-danger btn-sm" 
                    onclick="deleteMessage('${msg.id}')"
                >
                    <i class="bi bi-trash"></i>
                </button>
            </td>
        </tr>
    `).join('');
}

async function deleteMessage(messageId) {
    if (!(await window.showConfirm('Are you sure you want to delete this message?', 'Confirm Delete'))) {
        return;
    }

    try {
        const response = await fetch(`/api/admin/messages/${messageId}`, {
            method: 'DELETE'
        });

        if (!response.ok) throw new Error('Failed to delete message');

        await loadMessages();
        await window.showModal('Message deleted successfully', 'Success');
    } catch (error) {
        console.error('Error deleting message:', error);
        await window.showModal('Failed to delete message', 'Error');
    }
}

function switchTab(tabName, el) {
    // Hide all tabs
    document.querySelectorAll('.tab-content').forEach(tab => {
        tab.classList.remove('active');
    });

    // Remove active class from all tab buttons
    document.querySelectorAll('.admin-tab').forEach(tab => {
        tab.classList.remove('active');
    });

    // Show selected tab
    document.getElementById(`${tabName}Tab`).classList.add('active');
    
    // Add active class to clicked tab button
    try {
        if (el) el.classList.add('active');
        else if (event && event.target) event.target.closest('.admin-tab').classList.add('active');
    } catch (e) { /* ignore */ }
}

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

function toggleSidebar() {
    document.getElementById('sidebar').classList.toggle('show');
}

// Edit user modal handlers
async function openEditUserModal(userId) {
    const user = users.find(u => String(u.id) === String(userId));
    if (!user) {
        await window.showModal('User not found', 'Error');
        return;
    }
    document.getElementById('editUserId').value = user.id;
    document.getElementById('editDisplayName').value = user.display_name || '';
    document.getElementById('editUsername').value = user.username || '';
    document.getElementById('editEmail').value = user.email || '';
    document.getElementById('editRole').value = user.role || 'student';
    document.getElementById('editVerified').checked = !!user.is_verified;
    const modal = document.getElementById('editUserModal');
    if (!modal) {
        console.error('Edit user modal element not found');
        await window.showModal('Edit modal not available', 'Error');
        return;
    }
    // Logging for debugging visibility issues
    console.log('Opening edit modal for user', userId, 'modal element:', modal);
    // Add show class and ensure display for robustness across older browsers/styles
    modal.classList.add('show');
    modal.style.display = 'flex';
    // Force it above other overlays and ensure backdrop is visible
    modal.style.zIndex = 5000;
    modal.style.background = 'rgba(0,0,0,0.6)';
    const content = modal.querySelector('.modal-content');
    if (content) {
        content.style.transform = 'translateY(0) scale(1)';
        content.style.zIndex = 5001;
    }

    // attach save handler
    const saveBtn = document.getElementById('saveUserChangesBtn');
    saveBtn.onclick = async (ev) => {
        ev.preventDefault();
        saveBtn.disabled = true;
        try {
            const payload = {
                display_name: document.getElementById('editDisplayName').value.trim(),
                username: document.getElementById('editUsername').value.trim(),
                email: document.getElementById('editEmail').value.trim(),
                role: document.getElementById('editRole').value,
                is_verified: document.getElementById('editVerified').checked
            };
            const id = document.getElementById('editUserId').value;
            const resp = await fetch(`/api/admin/users/${encodeURIComponent(id)}`, {
                method: 'PUT',
                credentials: 'include',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });
                if (!resp.ok) {
                let err = 'Failed to save changes';
                try { const j = await resp.json(); if (j && j.error) err = j.error; } catch(e){}
                await window.showModal(err, 'Error');
                return;
            }
            await window.showModal('User updated', 'Success');
            closeEditUserModal();
            await loadUsers();
            await loadAnalytics();
        } catch (e) {
            console.error('Save user error', e);
            await window.showModal('Save failed', 'Error');
        } finally {
            saveBtn.disabled = false;
        }
    };
}

function closeEditUserModal() {
    const modal = document.getElementById('editUserModal');
    if (!modal) return;
    modal.classList.remove('show');
    // Also clear inline style if present
    modal.style.display = '';
}

async function logout() {
    if (!(await window.showConfirm('Are you sure you want to logout?', 'Confirm Logout'))) {
        return;
    }

    try {
        await fetch('/api/auth/logout', {
            method: 'POST'
        });
        window.location.href = '/login';
    } catch (error) {
        console.error('Logout error:', error);
        window.location.href = '/login';
    }
}

// =====================================================
// POLICY MANAGEMENT FUNCTIONS
// =====================================================

let allPolicies = [];
let filteredPolicies = [];

// Show policy section
function showPolicySection() {
    // Hide all tabs
    document.querySelectorAll('.tab-content').forEach(tab => tab.style.display = 'none');
    // Show policy tab
    document.getElementById('policiesTab').style.display = 'block';
    // Load policies
    loadPolicies();
}

// Load all policies
async function loadPolicies() {
    try {
        const response = await fetch('/api/policies', { credentials: 'include' });
        if (!response.ok) throw new Error('Failed to load policies');

        allPolicies = await response.json();
        filteredPolicies = [...allPolicies];
        displayPolicies();
    } catch (error) {
        console.error('Error loading policies:', error);
        window.showAlert('Failed to load policies', 'error');
    }
}

// Display policies in table
function displayPolicies() {
    const tbody = document.getElementById('policiesTableBody');
    
    if (filteredPolicies.length === 0) {
        tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;padding:20px;color:var(--dark-gray);">No policies found</td></tr>';
        return;
    }

    tbody.innerHTML = filteredPolicies.map(policy => {
        const categoryBadge = policy.category === 'both' ? 
            '<span class="badge badge-primary">Both</span>' :
            policy.category === 'reviewer' ?
            '<span class="badge badge-info">Reviewer</span>' :
            '<span class="badge badge-warning">Message</span>';
        
        const updatedDate = new Date(policy.updated_at).toLocaleDateString();
        
        return `
            <tr>
                <td>${policy.id}</td>
                <td style="font-weight:600;">${escapeHtml(policy.title)}</td>
                <td style="max-width:300px;">${escapeHtml(policy.description)}</td>
                <td>${categoryBadge}</td>
                <td>${updatedDate}</td>
                <td>
                    <button class="btn btn-sm btn-light" onclick="editPolicy(${policy.id})" title="Edit">
                        <i class="bi bi-pencil"></i>
                    </button>
                    <button class="btn btn-sm btn-danger" onclick="deletePolicy(${policy.id})" title="Delete">
                        <i class="bi bi-trash"></i>
                    </button>
                </td>
            </tr>
        `;
    }).join('');
}

// Filter policies by category
function filterPolicies() {
    const category = document.getElementById('policyFilterCategory').value;
    
    if (category === 'all') {
        filteredPolicies = [...allPolicies];
    } else {
        filteredPolicies = allPolicies.filter(p => p.category === category || p.category === 'both');
    }
    
    displayPolicies();
}

// Open add policy modal
function openAddPolicyModal() {
    document.getElementById('policyModalTitle').textContent = 'Add New Policy';
    document.getElementById('policyId').value = '';
    document.getElementById('policyTitle').value = '';
    document.getElementById('policyDescription').value = '';
    document.getElementById('policyCategory').value = '';
    document.getElementById('policyModal').classList.add('show');
    document.getElementById('policyModal').style.display = 'flex';
}

// Edit policy
function editPolicy(policyId) {
    const policy = allPolicies.find(p => p.id === policyId);
    if (!policy) return;

    document.getElementById('policyModalTitle').textContent = 'Edit Policy';
    document.getElementById('policyId').value = policy.id;
    document.getElementById('policyTitle').value = policy.title;
    document.getElementById('policyDescription').value = policy.description;
    document.getElementById('policyCategory').value = policy.category;
    document.getElementById('policyModal').classList.add('show');
    document.getElementById('policyModal').style.display = 'flex';
}

// Close policy modal
function closePolicyModal() {
    document.getElementById('policyModal').classList.remove('show');
    document.getElementById('policyModal').style.display = 'none';
}

// Save policy (create or update)
async function savePolicy() {
    const policyId = document.getElementById('policyId').value;
    const title = document.getElementById('policyTitle').value.trim();
    const description = document.getElementById('policyDescription').value.trim();
    const category = document.getElementById('policyCategory').value;

    if (!title || !description || !category) {
        window.showAlert('Please fill in all required fields', 'error');
        return;
    }

    const savePolicyBtn = document.getElementById('savePolicyBtn');
    savePolicyBtn.disabled = true;
    savePolicyBtn.innerHTML = '<i class="bi bi-hourglass-split"></i> Saving...';

    try {
        const url = policyId ? `/api/admin/policies/${policyId}` : '/api/admin/policies';
        const method = policyId ? 'PUT' : 'POST';

        const response = await fetch(url, {
            method,
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            body: JSON.stringify({ title, description, category })
        });

        if (!response.ok) {
            const error = await response.json();
            throw new Error(error.error || 'Failed to save policy');
        }

        window.showAlert(policyId ? 'Policy updated successfully' : 'Policy created successfully', 'success');
        closePolicyModal();
        loadPolicies();
    } catch (error) {
        console.error('Error saving policy:', error);
        window.showAlert(error.message, 'error');
    } finally {
        savePolicyBtn.disabled = false;
        savePolicyBtn.innerHTML = 'Save Policy';
    }
}

// Delete policy
async function deletePolicy(policyId) {
    if (!(await window.showConfirm('Are you sure you want to delete this policy?', 'Confirm Delete'))) {
        return;
    }

    try {
        const response = await fetch(`/api/admin/policies/${policyId}`, {
            method: 'DELETE',
            credentials: 'include'
        });

        if (!response.ok) {
            const error = await response.json();
            throw new Error(error.error || 'Failed to delete policy');
        }

        window.showAlert('Policy deleted successfully', 'success');
        loadPolicies();
    } catch (error) {
        console.error('Error deleting policy:', error);
        window.showAlert(error.message, 'error');
    }
}

// Helper function to escape HTML
function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}
