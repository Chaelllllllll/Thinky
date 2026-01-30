/**
 * Admin Dashboard JavaScript
 * Handles admin operations
 */

let users = [];
let reviewers = [];
let messages = [];
let currentUser = null;

document.addEventListener('DOMContentLoaded', () => {
    loadCurrentUser();
    loadAnalytics();
    loadUsers();
    loadReviewers();
    // Load moderation queue for admins
    if (typeof loadModeration === 'function') loadModeration();
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
    const searchTerm = document.getElementById('userSearch').value.toLowerCase();
    const filtered = users.filter(user => 
        (user.username && user.username.toLowerCase().includes(searchTerm)) ||
        (user.email && user.email.toLowerCase().includes(searchTerm)) ||
        (user.display_name && user.display_name.toLowerCase().includes(searchTerm))
    );

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
    const newRole = currentRole === 'admin' ? 'student' : 'admin';
    
    if (!(await window.showConfirm(`Change user role from ${currentRole} to ${newRole}?`, 'Confirm Role Change'))) {
        return;
    }

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
        displayModeration(data.reports || []);
    } catch (e) {
        console.error('Error loading moderation:', e);
        const tbody = document.getElementById('moderationTableBody');
        if (tbody) tbody.innerHTML = `<tr><td colspan="6" style="text-align:center;padding:20px;color:var(--danger);">Failed to load reports</td></tr>`;
    }
}

function displayModeration(reports) {
    const tbody = document.getElementById('moderationTableBody');
    if (!tbody) return;
    // Filter out already resolved or dismissed reports as a defensive client-side check
    const openReports = (reports || []).filter(r => !r.status || r.status === 'open');
    if (!openReports || openReports.length === 0) {
        tbody.innerHTML = `<tr><td colspan="6" style="text-align:center;padding:20px;color:var(--dark-gray);">No reports found</td></tr>`;
        return;
    }

    tbody.innerHTML = openReports.map(r => `
        <tr>
            <td>${escapeHtml(r.reviewers?.title || r.reviewer_id || '')}</td>
            <td>${escapeHtml(r.reporter?.username || '')}</td>
            <td>${escapeHtml(r.report_type || '')}</td>
            <td style="max-width:280px;">${escapeHtml((r.details || '').substring(0,300))}</td>
            <td>${new Date(r.created_at).toLocaleString()}</td>
            <td>
                <div class="action-buttons">
                    <button class="btn btn-warning btn-sm" onclick="openActionSelector('${r.id}')">Restrict</button>
                    <button class="btn btn-danger btn-sm" onclick="adminTakeAction('${r.id}','delete_user')">Delete User</button>
                </div>
            </td>
        </tr>
    `).join('');
}

// Open a custom modal to select restrict/ban durations and optional note
window.openActionSelector = function(reportId) {
    // build modal HTML
    const existing = document.getElementById('actionSelectorModal');
    if (existing) existing.remove();
    const div = document.createElement('div');
    div.id = 'actionSelectorModal';
    div.className = 'modal';
    div.style.display = 'flex';
    div.style.zIndex = 7000;
    div.innerHTML = `
        <div class="modal-content" style="max-width:640px;">
            <div class="modal-header"><h3 class="modal-title">Take Action</h3><button class="modal-close" id="actionSelectorClose">&times;</button></div>
            <div class="modal-body">
                <p>Select the type of action and duration:</p>
                <div style="margin-bottom:12px;">
                    <label><input type="radio" name="actionType" value="restrict" checked> Restrict posting</label>
                    &nbsp;&nbsp;
                    <label><input type="radio" name="actionType" value="ban"> Ban user</label>
                </div>
                <div id="restrictOptions">
                    <label><input type="radio" name="duration" value="1h" checked> 1 hour</label><br>
                    <label><input type="radio" name="duration" value="10h"> 10 hours</label><br>
                    <label><input type="radio" name="duration" value="24h"> 24 hours</label><br>
                    <label><input type="radio" name="duration" value="1w"> 1 week</label>
                </div>
                <div id="banOptions" style="display:none; margin-top:8px;">
                    <label><input type="radio" name="durationBan" value="24h" checked> 24 hours</label><br>
                    <label><input type="radio" name="durationBan" value="1w"> 1 week</label><br>
                    <label><input type="radio" name="durationBan" value="1m"> 1 month</label><br>
                    <label><input type="radio" name="durationBan" value="3m"> 3 months</label><br>
                    <label><input type="radio" name="durationBan" value="permanent"> Permanent</label>
                </div>
                <div style="margin-top:12px;">
                    <label>Optional note</label>
                    <textarea id="actionNote" class="form-control" placeholder="Add a note for the audit..." style="width:100%;height:80px;"></textarea>
                </div>
            </div>
            <div class="modal-footer">
                <button class="btn btn-light" id="actionCancel">Cancel</button>
                <button class="btn btn-primary" id="actionSubmit">Submit</button>
            </div>
        </div>`;
    document.body.appendChild(div);

    const close = () => { try{ div.remove(); }catch(e){} };
    document.getElementById('actionSelectorClose').onclick = close;
    document.getElementById('actionCancel').onclick = close;

    // toggle option groups
    div.querySelectorAll('input[name="actionType"]').forEach(r => r.addEventListener('change', (e)=>{
        const v = e.target.value;
        document.getElementById('restrictOptions').style.display = v === 'restrict' ? 'block' : 'none';
        document.getElementById('banOptions').style.display = v === 'ban' ? 'block' : 'none';
    }));

    document.getElementById('actionSubmit').onclick = async () => {
        const actionType = div.querySelector('input[name="actionType"]:checked').value;
        let duration = null;
        if (actionType === 'restrict') {
            duration = div.querySelector('input[name="duration"]:checked').value;
        } else {
            duration = div.querySelector('input[name="durationBan"]:checked').value;
        }
        const note = document.getElementById('actionNote').value || '';

        // convert duration to ISO until
        const until = computeUntilFromDuration(duration);
        // call adminTakeAction with opts
        await adminTakeAction(reportId, actionType === 'restrict' ? 'restrict' : 'ban', { until, note });
        close();
    };
};

function computeUntilFromDuration(duration) {
    if (!duration) return null;
    const now = new Date();
    if (duration === 'permanent') {
        // Treat permanent as a far-future timestamp (100 years) so server enforces it
        const far = new Date(); far.setFullYear(far.getFullYear() + 100);
        return far.toISOString();
    }
    if (duration.endsWith('h')) {
        const hrs = parseInt(duration.replace('h',''),10);
        now.setHours(now.getHours() + hrs);
        return now.toISOString();
    }
    if (duration.endsWith('w')) {
        const weeks = parseInt(duration.replace('w',''),10);
        now.setDate(now.getDate() + weeks * 7);
        return now.toISOString();
    }
    if (duration.endsWith('m')) {
        const months = parseInt(duration.replace('m',''),10);
        now.setMonth(now.getMonth() + months);
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
