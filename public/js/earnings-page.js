(function () {
    'use strict';

    const phpFmt = new Intl.NumberFormat('en-PH', { style: 'currency', currency: 'PHP', minimumFractionDigits: 2 });

    function setText(id, s) {
        const el = document.getElementById(id);
        if (el) el.textContent = s;
    }

    async function loadAll() {
        try {
            const [mRes, aRes, cRes] = await Promise.all([
                fetch('/api/me/monetization', { credentials: 'include' }),
                fetch('/api/me/monetization/analytics', { credentials: 'include' }),
                fetch('/api/me/monetization/cashouts', { credentials: 'include' })
            ]);

            if (mRes.status === 401) {
                window.location.href = '/login?next=' + encodeURIComponent('/earnings');
                return;
            }

            if (mRes.ok) {
                const m = await mRes.json();
                setText('stBalancePhp', phpFmt.format(Number(m.balance_php) || 0));
                setText('stLifetimePhp', phpFmt.format(Number(m.lifetime_credited_php) || 0));
                setText('stReadCount', String(m.total_qualified_reads ?? 0));
                setText('stRate', String(m.usd_to_php_rate ?? '—'));
                const minEl = document.getElementById('minCashoutLbl');
                if (minEl && m.min_cashout_php != null) {
                    minEl.textContent = phpFmt.format(Number(m.min_cashout_php));
                }
                const inp = document.getElementById('cashoutAmount');
                if (inp && m.min_cashout_php != null) {
                    inp.min = String(m.min_cashout_php);
                    inp.placeholder = String(m.min_cashout_php);
                }
            }

            if (aRes.ok) {
                const a = await aRes.json();
                const tbody = document.querySelector('#earnByReviewer tbody');
                if (tbody) {
                    const rows = a.by_reviewer || [];
                    if (!rows.length) {
                        tbody.innerHTML = '<tr><td colspan="3" style="opacity:0.75;">No qualified reads yet.</td></tr>';
                    } else {
                        tbody.innerHTML = rows
                            .map(
                                (r) =>
                                    `<tr><td><a href="/reviewer.html?id=${encodeURIComponent(r.reviewer_id)}">${escapeHtml(r.title)}</a></td><td>${r.qualified_reads}</td><td>${phpFmt.format(Number(r.total_php) || 0)}</td></tr>`
                            )
                            .join('');
                    }
                }
                const tot = document.getElementById('earnAnalyticsTotals');
                if (tot && a.totals) {
                    tot.textContent = `Total qualified reads: ${a.totals.qualified_reads} — Total credited: ${phpFmt.format(Number(a.totals.total_credited_php) || 0)}`;
                }
                const chart = document.getElementById('earnChart');
                if (chart && Array.isArray(a.last_30_days)) {
                    const days = a.last_30_days;
                    const maxPhp = Math.max(1, ...days.map((d) => Number(d.credits_php) || 0));
                    chart.innerHTML = days
                        .map((d) => {
                            const h = Math.max(4, Math.round((Number(d.credits_php) / maxPhp) * 96));
                            return `<div class="mini-bar" style="height:${h}px" title="${d.date}: ${phpFmt.format(Number(d.credits_php) || 0)}"></div>`;
                        })
                        .join('');
                }
            }

            if (cRes.ok) {
                const c = await cRes.json();
                const tb = document.querySelector('#earnCashouts tbody');
                if (tb) {
                    const list = c.cashouts || [];
                    if (!list.length) {
                        tb.innerHTML = '<tr><td colspan="3" style="opacity:0.75;">No cashout requests yet.</td></tr>';
                    } else {
                        tb.innerHTML = list
                            .map((row) => {
                                const when = row.created_at ? new Date(row.created_at).toLocaleString() : '';
                                return `<tr><td>${when}</td><td>${phpFmt.format(Number(row.amount_php) || 0)}</td><td>${escapeHtml(row.status)}</td></tr>`;
                            })
                            .join('');
                    }
                }
            }
        } catch (e) {
            console.error(e);
            window.showAlert && window.showAlert('error', 'Failed to load earnings.');
        }
    }

    function escapeHtml(t) {
        const d = document.createElement('div');
        d.textContent = t == null ? '' : String(t);
        return d.innerHTML;
    }

    document.getElementById('cashoutSubmitBtn')?.addEventListener('click', async () => {
        const inp = document.getElementById('cashoutAmount');
        const msg = document.getElementById('cashoutMsg');
        const raw = inp && inp.value.trim();
        const amount = parseFloat(raw);
        if (!Number.isFinite(amount)) {
            if (msg) msg.textContent = 'Enter a valid PHP amount.';
            return;
        }
        if (msg) msg.textContent = '';
        try {
            const resp = await fetch('/api/me/monetization/cashout', {
                method: 'POST',
                credentials: 'include',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ amount_php: amount })
            });
            const data = await resp.json().catch(() => ({}));
            if (!resp.ok) {
                if (msg) msg.textContent = data.error || 'Cashout failed.';
                window.showAlert && window.showAlert('error', data.error || 'Cashout failed.');
                return;
            }
            window.showAlert && window.showAlert('success', 'Cashout request submitted.', 4000);
            if (inp) inp.value = '';
            await loadAll();
        } catch (e) {
            if (msg) msg.textContent = 'Network error.';
        }
    });

    document.addEventListener('DOMContentLoaded', loadAll);
})();
