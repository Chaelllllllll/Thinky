// Moderation / Reporting client helpers
(function(){
    function createReportModal() {
        if (document.getElementById('reportModal')) return;
        const div = document.createElement('div');
        div.id = 'reportModal';
        div.className = 'modal';
        div.innerHTML = `
            <div class="modal-content" style="max-width:600px;">
                <div class="modal-header">
                    <h3 class="modal-title">Report</h3>
                    <button class="modal-close" onclick="closeReportModal()">&times;</button>
                </div>
                <div class="modal-body">
                    <input type="hidden" id="reportReviewerId">
                    <input type="hidden" id="reportMessageId">
                    <div class="form-group">
                        <label>Report Type</label>
                        <select id="reportType" class="form-control">
                            <option value="spam">Spam / Promotion</option>
                            <option value="inappropriate">Inappropriate Content</option>
                            <option value="copyright">Copyright Violation</option>
                            <option value="other">Other</option>
                        </select>
                    </div>
                    <div class="form-group">
                        <label>Details (optional)</label>
                        <textarea id="reportDetails" class="form-control" placeholder="Add any details to help moderators..."></textarea>
                    </div>
                </div>
                <div class="modal-footer">
                    <button class="btn btn-light" onclick="closeReportModal()">Cancel</button>
                    <button id="submitReportBtn" class="btn btn-primary">Submit Report</button>
                </div>
            </div>`;
        document.body.appendChild(div);
        document.getElementById('submitReportBtn').addEventListener('click', submitReport);
    }

    window.openReportModal = function(reviewerId) {
        createReportModal();
        const m = document.getElementById('reportModal');
        document.getElementById('reportReviewerId').value = reviewerId;
        document.getElementById('reportType').value = 'spam';
        document.getElementById('reportDetails').value = '';
        m.classList.add('show');
        m.style.display = 'flex';
        m.style.zIndex = 6000;
    };

    window.openMessageReportModal = function(messageId) {
        createReportModal();
        const m = document.getElementById('reportModal');
        document.getElementById('reportMessageId').value = messageId;
        document.getElementById('reportReviewerId').value = '';
        document.getElementById('reportType').value = 'inappropriate';
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
        const type = document.getElementById('reportType').value;
        const details = document.getElementById('reportDetails').value.trim();
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
