// Moderation / Reporting client helpers
(function(){
    let policiesCache = null;
    
    // Load policies from API
    async function loadPolicies() {
        if (policiesCache) return policiesCache;
        
        try {
            const response = await fetch('/api/policies');
            if (!response.ok) throw new Error('Failed to load policies');
            policiesCache = await response.json();
            return policiesCache;
        } catch (error) {
            console.error('Error loading policies:', error);
            return [];
        }
    }
    
    async function createReportModal(isMessage = false) {
        if (document.getElementById('reportModal')) return;
        
        // Load policies
        const policies = await loadPolicies();
        const relevantPolicies = isMessage 
            ? policies.filter(p => p.category === 'message' || p.category === 'both')
            : policies.filter(p => p.category === 'reviewer' || p.category === 'both');
        
        const div = document.createElement('div');
        div.id = 'reportModal';
        div.className = 'modal';
        div.innerHTML = `
            <div class="modal-content" style="max-width:600px;">
                <div class="modal-header">
                    <h3 class="modal-title"><i class="bi bi-flag-fill"></i> Report ${isMessage ? 'Message' : 'Content'}</h3>
                    <button class="modal-close" onclick="closeReportModal()">&times;</button>
                </div>
                <div class="modal-body">
                    <input type="hidden" id="reportReviewerId">
                    <input type="hidden" id="reportMessageId">
                    <div class="form-group">
                        <label>Policy Violation <span style="color:red;">*</span></label>
                        <select id="reportType" class="form-control" required>
                            <option value="">Select a policy violation...</option>
                            ${relevantPolicies.map(p => 
                                `<option value="${p.id}" title="${p.description}">${p.title}</option>`
                            ).join('')}
                        </select>
                        <small style="color:#666;display:block;margin-top:6px;">Select the policy that best describes the violation</small>
                    </div>
                    <div class="form-group">
                        <label>Additional Details (Optional)</label>
                        <textarea id="reportDetails" class="form-control" placeholder="Add any details to help moderators understand the context..." rows="4"></textarea>
                    </div>
                </div>
                <div class="modal-footer">
                    <button class="btn btn-light" onclick="closeReportModal()">Cancel</button>
                    <button id="submitReportBtn" class="btn btn-primary"><i class="bi bi-send-fill"></i> Submit Report</button>
                </div>
            </div>`;
        document.body.appendChild(div);
        document.getElementById('submitReportBtn').addEventListener('click', submitReport);
    }

    window.openReportModal = async function(reviewerId) {
        await createReportModal(false); // Reviewer report
        const m = document.getElementById('reportModal');
        document.getElementById('reportReviewerId').value = reviewerId;
        document.getElementById('reportMessageId').value = '';
        document.getElementById('reportType').value = '';
        document.getElementById('reportDetails').value = '';
        m.classList.add('show');
        m.style.display = 'flex';
        m.style.zIndex = 6000;
    };

    window.openMessageReportModal = async function(messageId) {
        await createReportModal(true); // Message report
        const m = document.getElementById('reportModal');
        document.getElementById('reportMessageId').value = messageId;
        document.getElementById('reportReviewerId').value = '';
        document.getElementById('reportType').value = '';
        document.getElementById('reportDetails').value = '';
        m.classList.add('show');
        m.style.display = 'flex';
        m.style.zIndex = 6000;
    };

    window.closeReportModal = function() {
        const m = document.getElementById('reportModal');
        if (!m) return;
        m.classList.remove('show');
        m.style.display = '';
    };

    async function submitReport() {
        const reviewerId = document.getElementById('reportReviewerId').value;
        const messageId = document.getElementById('reportMessageId').value;
        const policyId = document.getElementById('reportType').value;
        const details = document.getElementById('reportDetails').value.trim();
        
        // Validate policy selection
        if (!policyId) {
            window.showModal ? window.showModal('Please select a policy violation', 'Error') : alert('Please select a policy violation');
            return;
        }
        
        // Get selected policy title
        const policies = await loadPolicies();
        const selectedPolicy = policies.find(p => p.id.toString() === policyId);
        const type = selectedPolicy ? selectedPolicy.title : 'Policy Violation';
        
        const btn = document.getElementById('submitReportBtn');
        btn.disabled = true;
        try {
            let resp = null;
            if (messageId) {
                resp = await fetch(`/api/messages/${encodeURIComponent(messageId)}/report`, {
                    method: 'POST',
                    credentials: 'include',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ report_type: type, details })
                });
            } else {
                resp = await fetch(`/api/reviewers/${encodeURIComponent(reviewerId)}/report`, {
                    method: 'POST',
                    credentials: 'include',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ report_type: type, details })
                });
            }
            if (!resp.ok) {
                const j = await resp.json().catch(()=>null);
                const msg = j && j.error ? j.error : 'Failed to submit report';
                window.showModal ? window.showModal(msg, 'Error') : alert(msg);
                return;
            }
            window.showModal ? window.showModal('Report submitted — thank you. Moderators will review it shortly.', 'Report Sent') : alert('Report submitted — thank you. Moderators will review it shortly.');
            closeReportModal();
        } catch (e) {
            console.error('Submit report failed', e);
            window.showModal ? window.showModal('Failed to send report', 'Error') : alert('Failed to send report');
        } finally {
            btn.disabled = false;
        }
    }
})();
