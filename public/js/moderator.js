/**
 * Moderator UI script
 * Provides moderation-only capabilities (reviewer moderation & message moderation)
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

let currentUser = null;
let currentScope = 'reviewer'; // 'reviewer' or 'message'

document.addEventListener('DOMContentLoaded', () => {
    loadCommunityPolicies(); // Load policies first
    loadCurrentUser();
    // moderation data will be loaded below
    if (typeof loadModeration === 'function') loadModeration();

    try {
        const hash = (location.hash || '').replace('#','');
        const map = { 'users':'users', 'reviewers':'reviewers', 'moderation':'moderation', 'message-moderation':'moderation' };
        if (hash && map[hash]) setTimeout(() => switchTab(map[hash]), 50);
    } catch (e) {}

    try { updateSidebarActive(); } catch (e) {}
    // wire scope buttons if present
    const reviewerBtn = document.getElementById('modScopeReviewer');
    const messageBtn = document.getElementById('modScopeMessage');
    if (reviewerBtn && messageBtn) {
        reviewerBtn.addEventListener('click', () => setModerationScope('reviewer'));
        messageBtn.addEventListener('click', () => setModerationScope('message'));
    }

    window.addEventListener('hashchange', () => { updateSidebarActive(); loadModeration(); });
});

async function loadCurrentUser() {
    try {
        const resp = await fetch('/api/auth/me', { credentials: 'include' });
        if (!resp.ok) return window.location.href = '/login';
        const j = await resp.json();
        currentUser = j.user;
        if (!currentUser || !['moderator','admin'].includes(currentUser.role)) {
            await window.showModal('Access denied. Moderator privileges required.', 'Access Denied');
            window.location.href = '/dashboard';
            return;
        }
    } catch (e) {
        console.error('Failed to load current user', e);
        window.location.href = '/login';
    }
}

// Sidebar active helpers (moderator-specific)
function updateSidebarActive() {
    const links = Array.from(document.querySelectorAll('.sidebar-nav .sidebar-link'));
    let key = null;
    const p = (location.pathname || '').toLowerCase();
    if (p.includes('moderator')) {
        const h = (location.hash || '').replace('#','').toLowerCase();
        if (['moderation','message-moderation'].includes(h)) key = h;
    }
    if (!key) key = 'moderation';

    links.forEach(a => {
        a.classList.remove('active');
        const href = (a.getAttribute('href')||'').toLowerCase();
        if ((key === 'moderation' && href.includes('#moderation')) ||
            (key === 'message-moderation' && href.includes('#message-moderation'))) {
            a.classList.add('active');
        }
    });
}

// Reviewers listing and admin analytics are admin-only; moderators use the moderation endpoints only.

// Moderation queue
async function loadModeration() {
    try {
        const resp = await fetch('/api/admin/moderation', { credentials: 'include' });
        if (!resp.ok) throw new Error('Failed to load moderation');
        const data = await resp.json();
        // Prefer hash over currentScope; update currentScope to match hash
        const hash = (location.hash || '').replace('#','').toLowerCase();
        const inferred = (hash === 'message-moderation') ? 'message' : 'reviewer';
        const scope = inferred;
        currentScope = scope;
        try {
            const hdr = document.getElementById('moderationHeader');
            if (hdr) hdr.textContent = scope === 'message' ? 'Message Moderation' : 'Reviewer Moderation';
            // update button states
            const rBtn = document.getElementById('modScopeReviewer');
            const mBtn = document.getElementById('modScopeMessage');
            if (rBtn && mBtn) {
                if (scope === 'message') {
                    rBtn.classList.remove('btn-primary'); rBtn.classList.add('btn-light');
                    mBtn.classList.remove('btn-outline'); mBtn.classList.add('btn-primary');
                } else {
                    mBtn.classList.remove('btn-primary'); mBtn.classList.add('btn-outline');
                    rBtn.classList.remove('btn-light'); rBtn.classList.add('btn-primary');
                }
            }
        } catch (e) {}
        displayModeration(data.reports || [], scope);
    } catch (e) {
        console.error('Error loading moderation', e);
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
    
    let openReports = (reports || []).filter(r => !r.status || r.status === 'open');
    if (scope === 'message') openReports = openReports.filter(r => (r.type === 'chat') || (!!r.message));
    else openReports = openReports.filter(r => !(r.type === 'chat') && !r.message);
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
            <td><div class="action-buttons">
                <button class="btn btn-warning btn-sm" onclick="openMessageActionModal('${r.id}')">Take Action</button>
                <button class="btn btn-light btn-sm" onclick="dismissReport('${r.id}')">Dismiss</button>
            </div></td>
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
            <td><div class="action-buttons">
                <button class="btn btn-warning btn-sm" onclick="openReviewerActionModal('${r.id}')">Take Action</button>
                <button class="btn btn-light btn-sm" onclick="dismissReport('${r.id}')">Dismiss</button>
            </div></td>
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

function setModerationScope(scope) {
    if (!['reviewer','message'].includes(scope)) return;
    currentScope = scope;
    // update hash so links/refresh reflect scope
    if (scope === 'message') location.hash = 'message-moderation';
    else location.hash = 'moderation';
    loadModeration();
}

// Professional modal for message report actions (moderator version)
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
            await moderatorTakeAction(reportId, 'warn_message', { note });
        } else if (actionType === 'delete_message') {
            await moderatorTakeAction(reportId, 'delete_message', { note });
        } else {
            const until = computeUntilFromDuration(duration);
            const action = actionType === 'mute_user' ? 'mute' : 'ban_chat';
            await moderatorTakeAction(reportId, action, { until, note });
        }
        close();
    };
};

// Professional modal for reviewer report actions (moderator version)
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
            await moderatorTakeAction(reportId, 'warn_reviewer', { note });
        } else if (actionType === 'delete_reviewer') {
            await moderatorTakeAction(reportId, 'delete_content', { note });
        } else if (actionType === 'hide_reviewer') {
            const until = computeUntilFromDuration(duration);
            await moderatorTakeAction(reportId, 'hide_content', { until, note });
        } else if (actionType === 'suspend_author') {
            const until = computeUntilFromDuration(duration);
            await moderatorTakeAction(reportId, 'suspend_author', { until, note });
        }
        close();
    };
};

// Dismiss report without action
window.dismissReport = async function(reportId) {
    if (!await window.showConfirm('Mark this report as reviewed without taking action?', 'Dismiss Report')) return;
    await moderatorTakeAction(reportId, 'dismiss', {});
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

async function moderatorTakeAction(reportId, action, opts = {}) {
    if (!(await window.showConfirm('Are you sure you want to perform this action?', 'Confirm Action'))) return;
    let until = null;
    if (opts && Object.prototype.hasOwnProperty.call(opts, 'until')) until = opts.until;
    else {
        if (action === 'ban' || action === 'restrict') {
            const val = await window.showPrompt('Enter until date/time (ISO) or leave blank for indefinite (e.g. 2026-02-15T00:00:00Z):', 'Set Until', {placeholder:'2026-02-15T00:00:00Z', defaultValue:''});
            until = val || null;
        }
    }
    let note = '';
    if (opts && Object.prototype.hasOwnProperty.call(opts, 'note')) note = opts.note || '';
    else note = (await window.showPrompt('Optional note about the action:', 'Action Note', {placeholder:'Note', defaultValue:''})) || '';
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
        // moderator endpoint already performs deletion server-side; refresh moderation list
        await loadModeration();
    } catch (e) {
        console.error('Moderator action failed', e);
        await window.showModal('Failed to perform action', 'Error');
    }
}

function escapeHtml(text) {
    if (!text) return '';
    const div = document.createElement('div'); div.textContent = text; return div.innerHTML;
}
