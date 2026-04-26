
/* StarStore Admin — controller (Bootstrap 5) */
(() => {
'use strict';

// ---------------------- Utilities ----------------------
const $  = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
const escapeHtml = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const fmtNum = (n) => Number(n || 0).toLocaleString();
const fmtMoney = (n, sym = '$') => `${sym}${Number(n || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const fmtDate = (d) => {
    if (!d) return '—';
    const date = new Date(d); if (isNaN(date)) return '—';
    return date.toLocaleString();
};
const timeAgo = (d) => {
    if (!d) return '—';
    const diff = Date.now() - new Date(d).getTime();
    const s = Math.floor(diff/1000);
    if (s < 60) return 'just now';
    const m = Math.floor(s/60); if (m < 60) return `${m}m ago`;
    const h = Math.floor(m/60); if (h < 24) return `${h}h ago`;
    const day = Math.floor(h/24); return `${day}d ago`;
};
const debounce = (fn, ms = 300) => {
    let t; return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
};

// ---------------------- Toasts (Bootstrap) ----------------------
const Toast = {
    show(msg, type = 'info') {
        const c = $('#toast-container'); if (!c) return;
        const styles = {
            success: 'text-bg-success',
            error:   'text-bg-danger',
            warning: 'text-bg-warning',
            info:    'text-bg-primary'
        };
        const el = document.createElement('div');
        el.className = `toast align-items-center border-0 ${styles[type] || styles.info}`;
        el.setAttribute('role', 'alert');
        el.innerHTML = `
            <div class="d-flex">
                <div class="toast-body">${escapeHtml(msg)}</div>
                <button type="button" class="btn-close btn-close-white me-2 m-auto" data-bs-dismiss="toast"></button>
            </div>`;
        c.appendChild(el);
        const t = new bootstrap.Toast(el, { delay: 4000 });
        el.addEventListener('hidden.bs.toast', () => el.remove());
        t.show();
    }
};

// ---------------------- Confirm modal ----------------------
const Confirm = {
    open({ title = 'Confirm', body = 'Are you sure?', okText = 'Confirm', okVariant = 'primary', withInput = false, inputLabel = 'Reason' } = {}) {
        return new Promise(resolve => {
            const el = $('#confirm-modal'); if (!el || !window.bootstrap) return resolve(null);
            $('#confirm-title').textContent = title;
            $('#confirm-body').textContent = body;
            const wrap = $('#confirm-input-wrap');
            const input = $('#confirm-input');
            input.value = '';
            wrap.classList.toggle('d-none', !withInput);
            const ok = $('#confirm-ok');
            ok.className = 'btn btn-' + okVariant;
            ok.textContent = okText;
            const modal = bootstrap.Modal.getOrCreateInstance(el);
            let done = false;
            const finish = (val) => { if (done) return; done = true; modal.hide(); resolve(val); };
            const onOk = () => finish(withInput ? (input.value || '') : true);
            const onHide = () => { if (!done) finish(null); cleanup(); };
            const cleanup = () => {
                ok.removeEventListener('click', onOk);
                el.removeEventListener('hidden.bs.modal', onHide);
            };
            ok.addEventListener('click', onOk);
            el.addEventListener('hidden.bs.modal', onHide);
            modal.show();
        });
    }
};

// ---------------------- API ----------------------
let TOKEN = localStorage.getItem('admin_token') || null;

async function api(path, opts = {}) {
    const headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
    if (TOKEN) headers['x-telegram-id'] = TOKEN;
    const res = await fetch(path, { ...opts, headers });
    let data = null;
    try { data = await res.json(); } catch { data = null; }
    if (!res.ok) {
        const msg = (data && (data.error || data.message)) || `HTTP ${res.status}`;
        const err = new Error(msg); err.status = res.status; err.data = data; throw err;
    }
    return data;
}

// ---------------------- Auth flow ----------------------
const Auth = {
    async verify() {
        if (!TOKEN) return false;
        try {
            const r = await api('/api/admin/auth/verify');
            return !!(r && r.success && r.user && r.user.isAdmin);
        } catch { return false; }
    },
    async sendOTP(tgId) {
        return api('/api/admin/auth/send-otp', { method: 'POST', body: JSON.stringify({ tgId }) });
    },
    async verifyOTP(tgId, code) {
        return api('/api/admin/auth/verify-otp', { method: 'POST', body: JSON.stringify({ tgId, code }) });
    },
    setToken(t) { TOKEN = t; localStorage.setItem('admin_token', t); },
    clear() { TOKEN = null; localStorage.removeItem('admin_token'); }
};

function showLoginMessage(msg, type = 'info') {
    const el = $('#login-message'); if (!el) return;
    el.className = 'alert small mb-0 ' + (type === 'success' ? 'alert-success' : type === 'error' ? 'alert-danger' : 'alert-info');
    el.textContent = msg;
    el.classList.remove('d-none');
}

let otpTimerId = null;
function startOtpTimer(seconds) {
    const el = $('#otp-timer'); if (!el) return;
    el.classList.remove('d-none');
    clearInterval(otpTimerId);
    const tick = () => {
        const m = Math.floor(seconds / 60);
        const s = (seconds % 60).toString().padStart(2, '0');
        el.textContent = seconds > 0 ? `Code expires in ${m}:${s}` : 'Code expired — request a new one.';
        if (seconds <= 0) { clearInterval(otpTimerId); return; }
        seconds--;
    };
    tick();
    otpTimerId = setInterval(tick, 1000);
}

async function handleSendOTP() {
    const input = $('#telegram-id');
    const tgId = (input?.value || '').trim();
    if (!tgId) { showLoginMessage('Enter your Telegram ID.', 'error'); input?.focus(); return; }
    if (!/^\d+$/.test(tgId)) { showLoginMessage('Telegram ID must be numeric.', 'error'); return; }

    const btn = $('#send-otp-btn');
    const original = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner-border spinner-border-sm me-2"></span>Sending…';
    try {
        await Auth.sendOTP(tgId);
        $('#otp-section').classList.remove('d-none');
        $('#otp-input')?.focus();
        showLoginMessage('Code sent. Check your Telegram.', 'success');
        startOtpTimer(300);
        btn.innerHTML = '<i class="fas fa-paper-plane me-2"></i>Resend code';
    } catch (e) {
        showLoginMessage(e.message || 'Failed to send code.', 'error');
        btn.innerHTML = original;
    } finally {
        btn.disabled = false;
    }
}

async function handleVerifyOTP() {
    const tgId = ($('#telegram-id')?.value || '').trim();
    const code = ($('#otp-input')?.value || '').trim();
    if (!tgId || !/^\d{6}$/.test(code)) { showLoginMessage('Enter your 6-digit code.', 'error'); return; }

    const btn = $('#verify-otp-btn');
    btn.disabled = true; btn.innerHTML = '<span class="spinner-border spinner-border-sm"></span>';
    try {
        const r = await Auth.verifyOTP(tgId, code);
        if (!r || !r.success) throw new Error(r?.error || 'Invalid code');
        Auth.setToken(tgId);
        showLoginMessage('Signed in. Loading…', 'success');
        clearInterval(otpTimerId);
        setTimeout(enterApp, 400);
    } catch (e) {
        showLoginMessage(e.message || 'Verification failed.', 'error');
    } finally {
        btn.disabled = false; btn.innerHTML = '<i class="fas fa-check"></i>';
    }
}

// ---------------------- App shell ----------------------
function showLoading(show) { $('#loading-screen')?.classList.toggle('d-none', !show); }
function showLogin() { $('#login-screen')?.classList.remove('d-none'); $('#app')?.classList.add('d-none'); }
function hideLogin() { $('#login-screen')?.classList.add('d-none'); $('#app')?.classList.remove('d-none'); }

const VIEW_TITLES = {
    dashboard: 'Dashboard',
    performance: 'Performance',
    orders: 'Orders',
    withdrawals: 'Withdrawals',
    users: 'Users',
    notifications: 'Notifications',
    bots: 'Bot Simulator'
};

let currentView = 'dashboard';
function switchView(view) {
    if (!VIEW_TITLES[view]) view = 'dashboard';
    currentView = view;
    $$('.view').forEach(v => v.classList.add('d-none'));
    $('#view-' + view)?.classList.remove('d-none');
    $$('.nav-link.admin-nav').forEach(l => l.classList.toggle('active', l.dataset.view === view));
    $('#page-title').textContent = VIEW_TITLES[view];
    closeOffcanvas();
    loadView(view);
}

function closeOffcanvas() {
    const el = $('#sidebar');
    if (!el || !window.bootstrap) return;
    const oc = bootstrap.Offcanvas.getInstance(el);
    if (oc) oc.hide();
}

// ---------------------- Dashboard ----------------------
const charts = {};

async function loadDashboard() {
    try {
        const [stats, activity] = await Promise.all([
            api('/api/admin/stats').catch(() => ({})),
            api('/api/admin/activity/recent?limit=8').catch(() => ({ activities: [] }))
        ]);
        $('#stat-orders').textContent     = fmtNum(stats.totalOrders);
        $('#stat-users').textContent      = fmtNum(stats.totalUsers);
        $('#stat-pending-wd').textContent = fmtNum(stats.pendingWithdrawals);
        $('#stat-revenue').textContent    = fmtMoney(stats.revenueUsdt, '');
        renderActivity(activity.activities || activity.data || []);
        renderRevenueChart();
        renderOrdersChart(stats);
    } catch {
        Toast.show('Failed to load dashboard.', 'error');
    }
}

function renderActivity(items) {
    const el = $('#activity-list'); if (!el) return;
    if (!items.length) {
        el.innerHTML = `<div class="empty-state"><div class="empty-state-icon"><i class="fas fa-stream"></i></div>
            <p class="small mb-0">No recent activity.</p></div>`;
        return;
    }
    const ICON = {
        order:      ['fa-shopping-cart',   'bg-primary-soft'],
        purchase:   ['fa-shopping-cart',   'bg-primary-soft'],
        withdrawal: ['fa-money-bill-wave', 'bg-success-soft'],
        signup:     ['fa-user-plus',       'bg-info-soft'],
        login:      ['fa-sign-in-alt',     'bg-warning-soft']
    };
    el.innerHTML = items.map(a => {
        const t = a.activityType || a.type || 'event';
        const [icon, cls] = ICON[t] || ['fa-circle', 'bg-info-soft'];
        const title = a.title || (t.charAt(0).toUpperCase() + t.slice(1));
        const desc  = a.description || a.message || (a.userId ? `User ${a.userId}` : '');
        return `<div class="activity-item">
            <div class="activity-icon stat-icon ${cls}"><i class="fas ${icon}"></i></div>
            <div class="flex-grow-1 min-w-0">
                <div class="fw-semibold small">${escapeHtml(title)}</div>
                <div class="text-muted small">${escapeHtml(desc)}</div>
            </div>
            <div class="text-muted small text-nowrap">${timeAgo(a.timestamp || a.createdAt)}</div>
        </div>`;
    }).join('');
}

function renderRevenueChart() {
    const c = $('#revenue-chart'); if (!c || !window.Chart) return;
    if (charts.revenue) charts.revenue.destroy();
    const labels = []; const data = [];
    for (let i = 6; i >= 0; i--) {
        const d = new Date(Date.now() - i*86400000);
        labels.push(d.toLocaleDateString(undefined, { month:'short', day:'numeric' }));
        data.push(0);
    }
    charts.revenue = new Chart(c, {
        type: 'line',
        data: { labels, datasets: [{
            label: 'Revenue', data,
            borderColor: '#2563eb',
            backgroundColor: 'rgba(37,99,235,.08)',
            borderWidth: 2, fill: true, tension: .35, pointRadius: 3
        }] },
        options: {
            responsive: true, maintainAspectRatio: false,
            plugins: { legend: { display: false } },
            scales: { y: { beginAtZero: true, ticks: { precision: 0 } } }
        }
    });
}

function renderOrdersChart(stats) {
    const c = $('#orders-chart'); if (!c || !window.Chart) return;
    if (charts.orders) charts.orders.destroy();
    const total = Number(stats?.totalOrders || 0);
    const pending = Number(stats?.pendingWithdrawals || 0);
    const completed = Math.max(0, total - pending);
    charts.orders = new Chart(c, {
        type: 'doughnut',
        data: {
            labels: ['Completed', 'Pending', 'Other'],
            datasets: [{
                data: [completed, pending, Math.max(1, Math.round(total * 0.05))],
                backgroundColor: ['#16a34a', '#d97706', '#cbd5e1'],
                borderWidth: 0
            }]
        },
        options: {
            responsive: true, maintainAspectRatio: false, cutout: '65%',
            plugins: { legend: { position: 'bottom', labels: { boxWidth: 10 } } }
        }
    });
}

// ---------------------- Status badge ----------------------
function statusBadge(status) {
    const s = String(status || '').toLowerCase();
    const cls = ['pending','processing','completed','declined','failed'].includes(s) ? `s-${s}` : 's-default';
    return `<span class="badge status ${cls}">${escapeHtml(status || 'unknown')}</span>`;
}

// ---------------------- Orders ----------------------
const ordersState = { page: 1, limit: 20, total: 0, type: 'all', status: '', q: '' };

function tableLoading() {
    return `<div class="empty-state"><div class="spinner-border text-primary" role="status"></div><p class="small mt-2 mb-0">Loading…</p></div>`;
}

async function loadOrders() {
    const wrap = $('#orders-table');
    wrap.innerHTML = tableLoading();
    try {
        const params = new URLSearchParams({
            page: ordersState.page, limit: ordersState.limit,
            type: ordersState.type, status: ordersState.status, q: ordersState.q
        });
        const r = await api('/api/admin/orders?' + params);
        ordersState.total = r.total || 0;
        $('#orders-count').textContent = `${fmtNum(ordersState.total)} order${ordersState.total === 1 ? '' : 's'}`;
        $('#orders-page').textContent = `Page ${ordersState.page}`;
        const rows = r.orders || [];
        if (!rows.length) {
            wrap.innerHTML = `<div class="empty-state"><div class="empty-state-icon"><i class="fas fa-shopping-cart"></i></div>
                <p class="fw-semibold mb-1">No orders</p><p class="small mb-0">Try changing filters.</p></div>`;
            return;
        }
        wrap.innerHTML = `<table class="table mb-0"><thead><tr>
            <th>ID</th><th>Type</th><th>User</th><th>Amount</th><th>Status</th><th>Date</th><th class="text-end">Actions</th>
        </tr></thead><tbody>${rows.map(o => `
            <tr>
                <td class="cell-mono">${escapeHtml(o.id)}</td>
                <td><span class="badge ${o.type === 'buy' ? 'text-bg-primary' : 'text-bg-info'}">${escapeHtml(o.type)}</span></td>
                <td>${escapeHtml(o.username || o.telegramId || '—')}</td>
                <td class="fw-semibold">${fmtNum(o.amount)}</td>
                <td>${statusBadge(o.status)}</td>
                <td class="cell-mono">${fmtDate(o.dateCreated)}</td>
                <td class="text-end">
                    ${(o.status === 'pending' || o.status === 'processing') ? `
                        <button class="btn btn-success btn-sm me-1" data-order-action="complete" data-id="${escapeHtml(o.id)}"><i class="fas fa-check me-1"></i>Complete</button>
                        <button class="btn btn-outline-danger btn-sm" data-order-action="decline" data-id="${escapeHtml(o.id)}"><i class="fas fa-times me-1"></i>Decline</button>` : ''}
                </td>
            </tr>`).join('')}</tbody></table>`;
    } catch (e) {
        wrap.innerHTML = `<div class="empty-state"><div class="empty-state-icon"><i class="fas fa-triangle-exclamation"></i></div>
            <p class="small mb-0">${escapeHtml(e.message || 'Failed to load.')}</p></div>`;
    }
}

async function orderAction(id, action) {
    if (action === 'decline') {
        const ok = await Confirm.open({ title: 'Decline order', body: `Decline order ${id}? This cannot be undone.`, okText: 'Decline', okVariant: 'danger' });
        if (!ok) return;
    }
    try {
        await api(`/api/admin/orders/${encodeURIComponent(id)}/${action}`, { method: 'POST', body: JSON.stringify({}) });
        Toast.show(`Order ${action}d.`, 'success');
        loadOrders();
    } catch (e) {
        Toast.show(e.message || 'Action failed.', 'error');
    }
}

// ---------------------- Withdrawals ----------------------
const wdState = { page: 1, limit: 20, total: 0, status: '', q: '' };

async function loadWithdrawals() {
    const wrap = $('#wd-table');
    wrap.innerHTML = tableLoading();
    try {
        const params = new URLSearchParams({
            page: wdState.page, limit: wdState.limit, status: wdState.status, q: wdState.q
        });
        const r = await api('/api/admin/withdrawals?' + params);
        wdState.total = r.total || 0;
        $('#wd-count').textContent = `${fmtNum(wdState.total)} withdrawal${wdState.total === 1 ? '' : 's'}`;
        $('#wd-page').textContent = `Page ${wdState.page}`;
        const rows = r.withdrawals || [];
        if (!rows.length) {
            wrap.innerHTML = `<div class="empty-state"><div class="empty-state-icon"><i class="fas fa-credit-card"></i></div>
                <p class="fw-semibold mb-0">No withdrawals</p></div>`;
            return;
        }
        wrap.innerHTML = `<table class="table mb-0"><thead><tr>
            <th>ID</th><th>User</th><th>Amount</th><th>Wallet</th><th>Status</th><th>Date</th><th class="text-end">Actions</th>
        </tr></thead><tbody>${rows.map(w => `
            <tr>
                <td class="cell-mono">${escapeHtml(String(w._id || w.id || '').slice(-8))}</td>
                <td>${escapeHtml(w.username || w.userId || '—')}</td>
                <td class="fw-semibold">${fmtNum(w.amount)}</td>
                <td class="cell-mono" title="${escapeHtml(w.walletAddress || '')}">${escapeHtml((w.walletAddress || '').slice(0, 12))}${(w.walletAddress || '').length > 12 ? '…' : ''}</td>
                <td>${statusBadge(w.status)}</td>
                <td class="cell-mono">${fmtDate(w.createdAt)}</td>
                <td class="text-end">
                    ${w.status === 'pending' ? `
                        <button class="btn btn-success btn-sm me-1" data-wd-action="complete" data-id="${escapeHtml(w._id)}"><i class="fas fa-check me-1"></i>Complete</button>
                        <button class="btn btn-outline-danger btn-sm" data-wd-action="decline" data-id="${escapeHtml(w._id)}"><i class="fas fa-times me-1"></i>Decline</button>` : ''}
                </td>
            </tr>`).join('')}</tbody></table>`;
    } catch (e) {
        wrap.innerHTML = `<div class="empty-state"><div class="empty-state-icon"><i class="fas fa-triangle-exclamation"></i></div>
            <p class="small mb-0">${escapeHtml(e.message || 'Failed to load.')}</p></div>`;
    }
}

async function wdAction(id, action) {
    let body = {};
    if (action === 'decline') {
        const reason = await Confirm.open({
            title: 'Decline withdrawal',
            body: 'Provide a reason (optional) and confirm to decline this withdrawal.',
            okText: 'Decline', okVariant: 'danger', withInput: true
        });
        if (reason === null) return;
        body = { reason };
    } else {
        const ok = await Confirm.open({ title: 'Complete withdrawal', body: 'Mark this withdrawal as completed?', okText: 'Complete', okVariant: 'success' });
        if (!ok) return;
    }
    try {
        await api(`/api/admin/withdrawals/${encodeURIComponent(id)}/${action}`, { method: 'POST', body: JSON.stringify(body) });
        Toast.show(`Withdrawal ${action}d.`, 'success');
        loadWithdrawals();
    } catch (e) {
        Toast.show(e.message || 'Action failed.', 'error');
    }
}

// ---------------------- Users ----------------------
const usersState = { page: 1, limit: 25, total: 0, q: '', minutes: '0' };

async function loadUsers() {
    const wrap = $('#users-table');
    wrap.innerHTML = tableLoading();
    try {
        const params = new URLSearchParams({
            activeMinutes: usersState.minutes,
            page: usersState.page,
            limit: usersState.limit,
            q: usersState.q
        });
        const r = await api('/api/admin/users?' + params);
        const all = r.users || [];
        // If backend doesn't paginate/search, do it client-side as a fallback.
        let rows = all;
        if (typeof r.total !== 'number') {
            if (usersState.q) {
                const q = usersState.q.toLowerCase();
                rows = all.filter(u =>
                    String(u.id || '').toLowerCase().includes(q) ||
                    String(u.username || '').toLowerCase().includes(q)
                );
            }
            usersState.total = rows.length;
            const start = (usersState.page - 1) * usersState.limit;
            rows = rows.slice(start, start + usersState.limit);
        } else {
            usersState.total = r.total;
        }
        $('#users-count').textContent = `${fmtNum(usersState.total)} user${usersState.total === 1 ? '' : 's'}`;
        $('#users-page').textContent = `Page ${usersState.page}`;
        if (!rows.length) {
            wrap.innerHTML = `<div class="empty-state"><div class="empty-state-icon"><i class="fas fa-users"></i></div>
                <p class="fw-semibold mb-1">No users</p><p class="small mb-0">Try changing filters.</p></div>`;
            return;
        }
        wrap.innerHTML = `<table class="table mb-0"><thead><tr>
            <th>ID</th><th>Username</th><th>Joined</th><th>Last active</th><th>Stars</th>
        </tr></thead><tbody>${rows.map(u => `
            <tr>
                <td class="cell-mono">${escapeHtml(u.id)}</td>
                <td>${u.username ? '@' + escapeHtml(u.username) : '<span class="cell-mono">—</span>'}</td>
                <td class="cell-mono">${fmtDate(u.createdAt || u.dateJoined)}</td>
                <td class="cell-mono">${u.lastActive ? timeAgo(u.lastActive) : '—'}</td>
                <td class="fw-semibold">${fmtNum(u.stars || u.balance || 0)}</td>
            </tr>`).join('')}</tbody></table>`;
    } catch (e) {
        wrap.innerHTML = `<div class="empty-state"><div class="empty-state-icon"><i class="fas fa-triangle-exclamation"></i></div>
            <p class="small mb-0">${escapeHtml(e.message || 'Failed to load.')}</p></div>`;
    }
}

// ---------------------- Performance ----------------------
async function loadPerformance() {
    try {
        const r = await api('/api/admin/performance');
        const t = r.totals || {};
        $('#perf-overview').innerHTML = `
            <ul class="list-group list-group-flush">
                ${perfRow('Tracked users', fmtNum(t.usersCount))}
                ${perfRow('Active today', fmtNum(t.activeToday))}
                ${perfRow('Active 7d', fmtNum(t.active7d))}
                ${perfRow('Activity points', fmtNum(t.totalActivityPoints))}
                ${perfRow('Referral points', fmtNum(t.totalReferralPoints))}
                ${perfRow('Avg missions', (t.avgMissionsCompleted || 0).toFixed(1))}
            </ul>`;
        const top = r.top10 || [];
        if (!top.length) {
            $('#perf-top10').innerHTML = `<div class="empty-state"><div class="empty-state-icon"><i class="fas fa-trophy"></i></div><p class="small mb-0">No data.</p></div>`;
        } else {
            $('#perf-top10').innerHTML = `<div class="table-responsive"><table class="table mb-0"><thead><tr>
                <th>#</th><th>User</th><th>Score</th><th>Points</th><th>Referrals</th><th>Missions</th><th>Streak</th>
            </tr></thead><tbody>${top.map((e, i) => `
                <tr>
                    <td class="fw-semibold">${i+1}</td>
                    <td>${e.username ? '@'+escapeHtml(e.username) : '<span class="cell-mono">'+escapeHtml(e.userId)+'</span>'}</td>
                    <td class="fw-semibold">${e.score}</td>
                    <td>${fmtNum(e.totalPoints)}</td>
                    <td>${fmtNum(e.referralsCount)}</td>
                    <td>${fmtNum(e.missionsCompleted)}</td>
                    <td>${fmtNum(e.streak)}</td>
                </tr>`).join('')}</tbody></table></div>`;
        }
    } catch {
        Toast.show('Failed to load performance.', 'error');
    }
}
function perfRow(label, value) {
    return `<li class="list-group-item d-flex justify-content-between align-items-center px-0">
        <span class="text-muted small">${escapeHtml(label)}</span>
        <span class="fw-semibold">${escapeHtml(value)}</span>
    </li>`;
}

// ---------------------- Notifications ----------------------
async function sendNotification() {
    const target = $('#notify-target').value.trim() || 'all';
    const message = $('#notify-message').value.trim();
    const title = $('#notify-title').value.trim();
    if (!message) { Toast.show('Message is required.', 'warning'); return; }
    const btn = $('#notify-send');
    btn.disabled = true; btn.innerHTML = '<span class="spinner-border spinner-border-sm me-1"></span>Sending…';
    try {
        await api('/api/admin/notify', { method: 'POST', body: JSON.stringify({ target, message, title }) });
        Toast.show('Notification sent.', 'success');
        $('#notify-message').value = '';
        $('#notify-len').textContent = '0';
    } catch (e) {
        Toast.show(e.message || 'Failed to send.', 'error');
    } finally {
        btn.disabled = false; btn.innerHTML = '<i class="fas fa-paper-plane me-1"></i>Send';
    }
}

// ---------------------- Bot simulator ----------------------
async function loadBots() {
    try {
        const r = await api('/api/admin/bot-simulator/status');
        const badge = $('#bot-status-badge');
        badge.className = 'badge ' + (r.running ? 'text-bg-success' : r.enabled ? 'text-bg-warning' : 'text-bg-secondary');
        badge.textContent = r.running ? 'Running' : (r.enabled ? 'Enabled (idle)' : 'Disabled');
        $('#bot-count').textContent = fmtNum(r.botCount || 0);
        const t = $('#bot-toggle');
        t.disabled = false;
        t.innerHTML = `<i class="fas fa-power-off me-1"></i>${r.enabled ? 'Disable' : 'Enable'}`;
    } catch {
        Toast.show('Failed to load bot status.', 'error');
    }
}
async function toggleBots() {
    const t = $('#bot-toggle'); t.disabled = true;
    try {
        const r = await api('/api/admin/bot-simulator/toggle', { method: 'POST', body: JSON.stringify({}) });
        Toast.show(r.message || 'Toggled.', 'success');
        loadBots();
    } catch (e) {
        Toast.show(e.message || 'Toggle failed.', 'error');
        t.disabled = false;
    }
}

// ---------------------- Exports ----------------------
function exportCsv(path, filename) {
    fetch(path, { headers: { 'x-telegram-id': TOKEN || '' } })
        .then(r => r.ok ? r.blob() : Promise.reject(new Error('Export failed')))
        .then(blob => {
            const url = URL.createObjectURL(blob);
            const link = document.createElement('a');
            link.href = url; link.download = filename;
            document.body.appendChild(link); link.click(); link.remove();
            URL.revokeObjectURL(url);
            Toast.show('Export ready.', 'success');
        })
        .catch(e => Toast.show(e.message || 'Export failed.', 'error'));
}

// ---------------------- View dispatcher ----------------------
function loadView(view) {
    switch (view) {
        case 'dashboard':     return loadDashboard();
        case 'performance':   return loadPerformance();
        case 'orders':        return loadOrders();
        case 'withdrawals':   return loadWithdrawals();
        case 'users':         return loadUsers();
        case 'notifications': return;
        case 'bots':          return loadBots();
    }
}

// ---------------------- Wiring ----------------------
function bindEvents() {
    $('#send-otp-btn')?.addEventListener('click', handleSendOTP);
    $('#verify-otp-btn')?.addEventListener('click', handleVerifyOTP);
    $('#telegram-id')?.addEventListener('keydown', e => { if (e.key === 'Enter') handleSendOTP(); });
    $('#otp-input')?.addEventListener('keydown', e => { if (e.key === 'Enter') handleVerifyOTP(); });

    $$('.nav-link.admin-nav').forEach(l => l.addEventListener('click', () => switchView(l.dataset.view)));
    $$('[data-go]').forEach(b => b.addEventListener('click', () => switchView(b.dataset.go)));

    $('#refresh-btn')?.addEventListener('click', () => loadView(currentView));
    $('#logout-btn')?.addEventListener('click', () => { Auth.clear(); location.reload(); });
    $('#refresh-activity')?.addEventListener('click', loadDashboard);

    $('#orders-type')?.addEventListener('change', e => { ordersState.type = e.target.value; ordersState.page = 1; loadOrders(); });
    $('#orders-status')?.addEventListener('change', e => { ordersState.status = e.target.value; ordersState.page = 1; loadOrders(); });
    $('#orders-search')?.addEventListener('input', debounce(e => { ordersState.q = e.target.value.trim(); ordersState.page = 1; loadOrders(); }, 350));
    $('#orders-prev')?.addEventListener('click', () => { if (ordersState.page > 1) { ordersState.page--; loadOrders(); } });
    $('#orders-next')?.addEventListener('click', () => { if (ordersState.page * ordersState.limit < ordersState.total) { ordersState.page++; loadOrders(); } });

    $('#wd-status')?.addEventListener('change', e => { wdState.status = e.target.value; wdState.page = 1; loadWithdrawals(); });
    $('#wd-search')?.addEventListener('input', debounce(e => { wdState.q = e.target.value.trim(); wdState.page = 1; loadWithdrawals(); }, 350));
    $('#wd-prev')?.addEventListener('click', () => { if (wdState.page > 1) { wdState.page--; loadWithdrawals(); } });
    $('#wd-next')?.addEventListener('click', () => { if (wdState.page * wdState.limit < wdState.total) { wdState.page++; loadWithdrawals(); } });

    $('#users-active')?.addEventListener('change', e => { usersState.minutes = e.target.value; usersState.page = 1; loadUsers(); });
    $('#users-search')?.addEventListener('input', debounce(e => { usersState.q = e.target.value.trim(); usersState.page = 1; loadUsers(); }, 350));
    $('#users-prev')?.addEventListener('click', () => { if (usersState.page > 1) { usersState.page--; loadUsers(); } });
    $('#users-next')?.addEventListener('click', () => { if (usersState.page * usersState.limit < usersState.total) { usersState.page++; loadUsers(); } });

    $('#notify-message')?.addEventListener('input', e => { $('#notify-len').textContent = e.target.value.length; });
    $$('[data-set-target]').forEach(b => b.addEventListener('click', () => { $('#notify-target').value = b.dataset.setTarget; }));
    $('#notify-clear')?.addEventListener('click', () => {
        $('#notify-message').value = ''; $('#notify-target').value = ''; $('#notify-title').value = ''; $('#notify-len').textContent = '0';
    });
    $('#notify-send')?.addEventListener('click', sendNotification);

    $('#bot-toggle')?.addEventListener('click', toggleBots);

    document.addEventListener('click', e => {
        const exp = e.target.closest('[data-action]');
        if (exp) {
            if (exp.dataset.action === 'export-orders') exportCsv('/api/admin/orders/export', 'orders.csv');
            if (exp.dataset.action === 'export-withdrawals') exportCsv('/api/admin/withdrawals/export', 'withdrawals.csv');
        }
        const oa = e.target.closest('[data-order-action]');
        if (oa) orderAction(oa.dataset.id, oa.dataset.orderAction);
        const wa = e.target.closest('[data-wd-action]');
        if (wa) wdAction(wa.dataset.id, wa.dataset.wdAction);
    });

    window.addEventListener('resize', () => Object.values(charts).forEach(c => c?.resize?.()));
}

// ---------------------- Boot ----------------------
async function enterApp() {
    hideLogin();
    $('#admin-name').textContent = TOKEN ? `Admin ${TOKEN}` : 'Admin';
    switchView('dashboard');
}

async function init() {
    bindEvents();
    showLoading(true);
    try {
        if (TOKEN && await Auth.verify()) {
            await enterApp();
        } else {
            Auth.clear();
            showLogin();
        }
    } finally {
        showLoading(false);
    }
}

document.addEventListener('DOMContentLoaded', init);
})();
