

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
let CSRF  = sessionStorage.getItem('admin_csrf') || null;

async function fetchCsrfIfNeeded(forceRefresh = false) {
    if (CSRF && !forceRefresh) {
        console.log('Using cached CSRF token');
        return CSRF;
    }
    try {
        console.log('Fetching CSRF token from /api/admin/csrf...');
        const res = await fetch('/api/admin/csrf', {
            headers: TOKEN ? { 'x-telegram-id': TOKEN } : {},
            credentials: 'same-origin'
        });
        
        console.log('CSRF endpoint response:', res.status, res.statusText);
        
        if (!res.ok) {
            console.error('CSRF fetch failed with status:', res.status);
            // If 401/403, session is invalid - force logout
            if (res.status === 401 || res.status === 403) {
                console.error('Session invalid, logging out');
                forceAdminLogout('Session expired - please sign in again');
                return null;
            }
            // For other errors, return cached token if available
            console.warn('CSRF endpoint error, using cached token if available');
            return CSRF;
        }
        
        const data = await res.json().catch(() => {
            console.error('Failed to parse CSRF response');
            return {};
        });
        
        if (data && data.csrfToken) {
            CSRF = data.csrfToken;
            try { sessionStorage.setItem('admin_csrf', CSRF); } catch {}
            console.log('✓ CSRF token obtained:', CSRF.slice(0, 8) + '...');
            return CSRF;
        } else {
            console.error('CSRF endpoint returned no token:', data);
            return CSRF;
        }
    } catch (err) {
        console.error('CSRF fetch error:', err.message);
        return CSRF;
    }
}

async function api(path, opts = {}) {
    const headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
    if (TOKEN) headers['x-telegram-id'] = TOKEN;
    const method = (opts.method || 'GET').toUpperCase();
    
    // For any non-GET request, ensure we have a valid CSRF token
    if (method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS') {
        // Always try to fetch fresh token for requests that need it
        if (!CSRF) {
            console.log('No cached CSRF, fetching fresh token...');
            await fetchCsrfIfNeeded(true);  // Force fresh fetch
        }
        if (CSRF) {
            headers['x-csrf-token'] = CSRF;
            console.log('CSRF token added to request headers');
        } else {
            console.error('Failed to obtain CSRF token for', method, path);
        }
    }
    
    let res = await fetch(path, { ...opts, headers, credentials: 'same-origin' });
    
    if (res.status === 403 && method !== 'GET' && method !== 'HEAD') {
        let probe = null;
        try { probe = await res.clone().json(); } catch {}
        if (probe && /csrf/i.test(probe.error || '')) {
            console.warn('CSRF validation failed, attempting refresh and retry...');
            CSRF = null;
            try { sessionStorage.removeItem('admin_csrf'); } catch {}
            await fetchCsrfIfNeeded(true);  // Force fresh fetch
            if (CSRF) {
                headers['x-csrf-token'] = CSRF;
                console.log('Retrying with refreshed CSRF token');
                res = await fetch(path, { ...opts, headers, credentials: 'same-origin' });
            } else {
                console.error('Could not obtain fresh CSRF token after failure');
            }
        }
    }
    
    let data = null;
    try { data = await res.json(); } catch { data = null; }
    if (!res.ok) {
        const msg = (data && (data.error || data.message)) || `HTTP ${res.status}`;
        const err = new Error(msg); err.status = res.status; err.data = data; throw err;
    }
    return data;
}

function forceAdminLogout(message = 'Session ended. Please sign in again.') {
    Auth.clear();
    clearTimeout(idleTimer); clearTimeout(warnTimer); clearInterval(hbTimer);
    $('#app')?.classList.add('d-none');
    $('#login-screen')?.classList.remove('d-none');
    Toast.show(message, 'warning');
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
    setCsrf(c) {
        CSRF = c || null;
        try { c ? sessionStorage.setItem('admin_csrf', c) : sessionStorage.removeItem('admin_csrf'); } catch {}
    },
    clear() {
        TOKEN = null; CSRF = null;
        localStorage.removeItem('admin_token');
        try { sessionStorage.removeItem('admin_csrf'); } catch {}
    }
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
        if (r.csrfToken) Auth.setCsrf(r.csrfToken);
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
    bots: 'Bot Simulator',
    sessions: 'Admin Sessions',
    fulfillment: 'Auto-Fulfillment'
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
                <td class="fw-semibold">${o.type === 'sell' ? `★ ${fmtNum(o.stars || o.amount || 0)}` : `${fmtNum(o.amount || 0)} USDT`}</td>
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
            <th>ID</th><th>Username</th><th>Status</th><th>Joined</th><th>Last active</th><th>Stars</th><th class="text-end">Actions</th>
        </tr></thead><tbody>${rows.map(u => `
            <tr>
                <td class="cell-mono">${escapeHtml(u.id)}</td>
                <td>${u.username ? '@' + escapeHtml(u.username) : '<span class="cell-mono">—</span>'}</td>
                <td>${u.banned ? '<span class="badge text-bg-danger">Banned</span>' : '<span class="badge text-bg-success">Active</span>'}</td>
                <td class="cell-mono">${fmtDate(u.createdAt || u.dateJoined)}</td>
                <td class="cell-mono">${u.lastActive ? timeAgo(u.lastActive) : '—'}</td>
                <td class="fw-semibold">${fmtNum(u.stars || u.balance || 0)}</td>
                <td class="text-end">
                    <div class="btn-group btn-group-sm" role="group">
                        <button class="btn btn-outline-success" title="Adjust balance" data-user-balance="${escapeHtml(u.id)}"><i class="fas fa-coins"></i></button>
                        <button class="btn btn-outline-primary" title="Audit balance" data-user-audit="${escapeHtml(u.id)}"><i class="fas fa-calculator"></i></button>
                        <button class="btn btn-outline-warning" title="Repair referrals" data-user-repair="${escapeHtml(u.id)}"><i class="fas fa-wrench"></i></button>
                        <button class="btn btn-outline-secondary" title="Diagnose referrals" data-user-diagnose="${escapeHtml(u.id)}"><i class="fas fa-stethoscope"></i></button>
                        ${u.banned
                            ? `<button class="btn btn-outline-secondary" title="Unban" data-user-unban="${escapeHtml(u.id)}"><i class="fas fa-unlock"></i></button>`
                            : `<button class="btn btn-outline-danger" title="Ban" data-user-ban="${escapeHtml(u.id)}"><i class="fas fa-ban"></i></button>`}
                        <button class="btn btn-outline-primary" title="Send DM" data-user-dm="${escapeHtml(u.id)}"><i class="fas fa-paper-plane"></i></button>
                        <button class="btn btn-outline-info" title="View raw" data-user-view="${escapeHtml(u.id)}"><i class="fas fa-eye"></i></button>
                    </div>
                </td>
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

// ---------------------- Notifications / Broadcast ----------------------
// Broadcast state
let broadcastState = {
    selectedGroup: null,
    targetGroupLabels: {
        'all': 'All Users',
        'active_30d': 'Active (Past 30 Days)',
        'buyers_30d': 'Buyers (Past 30 Days)',
        'sellers_30d': 'Sellers (Past 30 Days)',
        'both_30d': 'Both Buyers & Sellers (Past 30 Days)',
        'ambassadors': 'Ambassadors',
        'inactive': 'Inactive (30+ Days)'
    }
};

async function sendNotification() {
    const message = $('#notify-message').value.trim();
    if (!message) { Toast.show('Message is required.', 'warning'); return; }
    if (!broadcastState.selectedGroup) { Toast.show('Please select a target group.', 'warning'); return; }

    const confirmed = await Confirm.open({
        title: 'Send Broadcast',
        body: `Send this message to: ${broadcastState.targetGroupLabels[broadcastState.selectedGroup]}?\n\nThis will notify all admins of the results.`,
        okText: 'Send Broadcast',
        okVariant: 'primary'
    });
    
    if (!confirmed) return;

    const btn = $('#notify-send');
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner-border spinner-border-sm me-1"></span>Sending…';
    
    try {
        const result = await api('/api/admin/notify', {
            method: 'POST',
            body: JSON.stringify({
                targetGroup: broadcastState.selectedGroup,
                message: message,
                sendTelegram: true,
                createDbNotification: true,
                sendEmail: broadcastState.selectedGroup === 'ambassadors'
            })
        });
        
        Toast.show(`Broadcast sent to ${result.telegramSent} users. Results sent to all admins.`, 'success');
        $('#notify-message').value = '';
        $('#notify-len').textContent = '0';
        broadcastState.selectedGroup = null;
        $('#broadcast-selected').style.display = 'none';
        btn.disabled = true;
        updateTargetGroupButtons();
    } catch (e) {
        Toast.show(e.message || 'Failed to send broadcast.', 'error');
    } finally {
        btn.disabled = false;
        btn.innerHTML = '<i class="fas fa-paper-plane me-1"></i>Send Broadcast';
    }
}

function updateTargetGroupButtons() {
    $$('[data-target-group]').forEach(btn => {
        if (btn.dataset.targetGroup === broadcastState.selectedGroup) {
            btn.classList.remove('btn-outline-primary');
            btn.classList.add('btn-primary');
        } else {
            btn.classList.remove('btn-primary');
            btn.classList.add('btn-outline-primary');
        }
    });

    if (broadcastState.selectedGroup) {
        $('#broadcast-selected').style.display = 'block';
        $('#selected-target-display').textContent = broadcastState.targetGroupLabels[broadcastState.selectedGroup];
        $('#notify-send').disabled = false;
    } else {
        $('#broadcast-selected').style.display = 'none';
        $('#notify-send').disabled = true;
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

// ---------------------- Admin Sessions ----------------------
async function loadSessions() {
    const wrap = $('#sessions-table');
    if (!wrap) return;
    wrap.innerHTML = tableLoading();
    try {
        const r = await api('/api/admin/sessions');
        const rows = r.sessions || [];
        if (!rows.length) {
            wrap.innerHTML = `<div class="empty-state"><div class="empty-state-icon"><i class="fas fa-shield-halved"></i></div>
                <p class="small mb-0">No active sessions.</p></div>`;
            return;
        }
        wrap.innerHTML = `<table class="table mb-0"><thead><tr>
            <th>Admin</th><th>IP</th><th>Location</th><th>Device</th><th>Signed in</th><th>Last active</th><th class="text-end">Actions</th>
        </tr></thead><tbody>${rows.map(s => `
            <tr>
                <td class="cell-mono">${escapeHtml(s.tgId)}${s.isCurrent ? ' <span class="badge text-bg-primary ms-1">you</span>' : ''}</td>
                <td class="cell-mono">${escapeHtml(s.ip || '—')}</td>
                <td>${escapeHtml([s.city, s.country].filter(Boolean).join(', ') || '—')}</td>
                <td class="small">${escapeHtml(s.device?.device || '')} · ${escapeHtml(s.device?.os || '')} · ${escapeHtml(s.device?.browser || '')}</td>
                <td class="cell-mono">${fmtDate(s.createdAt)}</td>
                <td class="cell-mono">${timeAgo(s.lastActive)}</td>
                <td class="text-end">
                    <button class="btn btn-outline-danger btn-sm" data-session-terminate="${escapeHtml(s.sid)}" ${s.isCurrent ? 'title="This will sign you out"' : ''}>
                        <i class="fas fa-power-off me-1"></i>Terminate
                    </button>
                </td>
            </tr>`).join('')}</tbody></table>`;
    } catch (e) {
        wrap.innerHTML = `<div class="empty-state"><div class="empty-state-icon"><i class="fas fa-triangle-exclamation"></i></div>
            <p class="small mb-0">${escapeHtml(e.message || 'Failed to load.')}</p></div>`;
    }
}

async function terminateSession(sid) {
    const ok = await Confirm.open({ title: 'Terminate session', body: 'Terminate this admin session?', okText: 'Terminate', okVariant: 'danger' });
    if (!ok) return;
    try {
        const r = await api(`/api/admin/sessions/${encodeURIComponent(sid)}/terminate`, { method: 'POST', body: JSON.stringify({}) });
        Toast.show('Session terminated.', 'success');
        if (r?.terminatedCurrent) {
            setTimeout(() => forceAdminLogout('Your admin session was terminated.'), 250);
            return;
        }
        loadSessions();
    } catch (e) { Toast.show(e.message || 'Failed.', 'error'); }
}

// ---------------------- Send DM modal ----------------------
function openDmModal(tgId) {
    const el = $('#dm-modal'); if (!el || !window.bootstrap) return;
    $('#dm-user-id').textContent = tgId;
    $('#dm-message').value = '';
    el.dataset.tgId = tgId;
    bootstrap.Modal.getOrCreateInstance(el).show();
}
async function sendDm() {
    const el = $('#dm-modal'); if (!el) return;
    const tgId = el.dataset.tgId;
    const msg = $('#dm-message').value.trim();
    if (!msg) { Toast.show('Message required.', 'warning'); return; }
    const btn = $('#dm-send'); btn.disabled = true;
    try {
        await api(`/api/admin/users/${encodeURIComponent(tgId)}/dm`, { method: 'POST', body: JSON.stringify({ message: msg }) });
        Toast.show('Message sent.', 'success');
        bootstrap.Modal.getInstance(el)?.hide();
    } catch (e) { Toast.show(e.message || 'Failed.', 'error'); }
    finally { btn.disabled = false; }
}

// ---------------------- User management actions ----------------------
async function banUser(tgId) {
    const reason = prompt(`Ban user ${tgId}?\n\nReason (sent to user):`, 'Violation of terms');
    if (reason === null) return;
    try {
        await api(`/api/admin/users/${encodeURIComponent(tgId)}/ban`, { method: 'POST', body: JSON.stringify({ reason }) });
        Toast.show('User banned.', 'success'); loadUsers();
    } catch (e) { Toast.show(e.message || 'Failed.', 'error'); }
}
async function unbanUser(tgId) {
    if (!confirm(`Reinstate user ${tgId}?`)) return;
    try {
        await api(`/api/admin/users/${encodeURIComponent(tgId)}/unban`, { method: 'POST', body: JSON.stringify({}) });
        Toast.show('User reinstated.', 'success'); loadUsers();
    } catch (e) { Toast.show(e.message || 'Failed.', 'error'); }
}
async function adjustBalance(tgId) {
    const raw = prompt(`Adjust balance for user ${tgId}\n\nEnter delta (e.g. 100 or -50):`, '');
    if (raw === null) return;
    const delta = Number(raw);
    if (!Number.isFinite(delta) || delta === 0) { Toast.show('Invalid delta.', 'warning'); return; }
    const reason = prompt('Reason for adjustment:', 'Admin adjustment') || 'Admin adjustment';
    try {
        const r = await api(`/api/admin/users/${encodeURIComponent(tgId)}/adjust-balance`, { method: 'POST', body: JSON.stringify({ delta, reason }) });
        Toast.show(`Balance: ${r.before} → ${r.after}`, 'success'); loadUsers();
    } catch (e) { Toast.show(e.message || 'Failed.', 'error'); }
}
async function viewUser(tgId) {
    try {
        const r = await api(`/api/admin/users/${encodeURIComponent(tgId)}`);
        alert(JSON.stringify(r.user, null, 2));
    } catch (e) { Toast.show(e.message || 'Failed.', 'error'); }
}

async function auditUserBalance(tgId) {
    try {
        const r = await api('/api/admin/audit-and-recover-balances', { method: 'POST', body: JSON.stringify({ userId: tgId, sendNotification: false }) });
        const a = r.audit || {};
        Toast.show(`Audit: ${a.totalReferralsCount || 0} active referrals, ${fmtMoney(a.expectingBalance || 0)}`, 'success');
    } catch (e) { Toast.show(e.message || 'Audit failed.', 'error'); }
}
async function repairUserReferrals(tgId) {
    const ok = await Confirm.open({ title: 'Repair referrals', body: `Repair referral records for user ${tgId}?`, okText: 'Repair', okVariant: 'warning' });
    if (!ok) return;
    try {
        const r = await api('/api/admin/manual-repair-referrals', { method: 'POST', body: JSON.stringify({ userId: tgId }) });
        Toast.show(`Repair complete. Repaired: ${r.repaired || 0}`, 'success');
        loadUsers();
    } catch (e) { Toast.show(e.message || 'Repair failed.', 'error'); }
}
async function diagnoseUser(tgId) {
    try {
        const r = await api('/api/admin/diagnose-missing-balances', { method: 'POST', body: JSON.stringify({ userId: tgId }) });
        const issues = r.diagnostics?.issues?.length || 0;
        Toast.show(issues ? `${issues} referral issue(s) found.` : 'No referral issues found.', issues ? 'warning' : 'success');
    } catch (e) { Toast.show(e.message || 'Diagnosis failed.', 'error'); }
}


// ---------------------- Idle timer & heartbeat ----------------------
let IDLE_MS = 15 * 60 * 1000;
let idleTimer = null, warnTimer = null, hbTimer = null;
let lastActivityAt = Date.now();
function resetIdle() {
    lastActivityAt = Date.now();
    clearTimeout(idleTimer); clearTimeout(warnTimer);
    warnTimer = setTimeout(() => Toast.show('You will be signed out in 1 minute due to inactivity.', 'warning'), Math.max(0, IDLE_MS - 60000));
    idleTimer = setTimeout(async () => {
        try { await fetch('/api/admin/logout', { method: 'POST', credentials: 'same-origin' }); } catch {}
        forceAdminLogout('Signed out due to inactivity.');
    }, IDLE_MS);
}
function startIdleTracking() {
    ['click','keydown','mousemove','touchstart','scroll'].forEach(ev =>
        document.addEventListener(ev, resetIdle, { passive: true })
    );
    resetIdle();
    clearInterval(hbTimer);
    hbTimer = setInterval(async () => {
        try {
            const r = await api('/api/admin/heartbeat', { method: 'POST', body: JSON.stringify({ lastActivityAt }) });
            if (r?.idleTimeoutMs) IDLE_MS = r.idleTimeoutMs;
        } catch (e) {
            if (e.status === 403 || e.status === 401) {
                forceAdminLogout('Session ended. Please sign in again.');
            }
        }
    }, 15000);
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
        case 'sessions':      return loadSessions();
        case 'fulfillment':   return loadFulfillment();
    }
}

async function loadFulfillment() {
    try {
        const data = await api('/api/admin/fulfillment/settings');
        if (!data.success) throw new Error(data.error || 'Failed');
        const { settings, providers } = data;
        const fill = (sel, val) => {
            const el = $(sel); if (!el) return;
            el.innerHTML = providers.map(p => `<option value="${p.id}" ${p.id === val ? 'selected' : ''}>${escapeHtml(p.label)}</option>`).join('');
        };
        fill('#ff-stars-provider', settings.starsProvider);
        fill('#ff-premium-provider', settings.premiumProvider);
        fill('#ff-fallback-stars-provider', settings.fallbackStarsProvider);
        fill('#ff-fallback-premium-provider', settings.fallbackPremiumProvider);
        $('#ff-enabled').checked = !!settings.autoFulfillEnabled;
        $('#ff-max-amount').value = settings.maxAutoAmountUsdt ?? 100;
        $('#ff-max-attempts').value = settings.maxAttempts ?? 3;
    } catch (err) {
        Toast.show(`Failed to load fulfillment settings: ${err.message}`, 'error');
    }
}

async function saveFulfillment() {
    const body = {
        autoFulfillEnabled: $('#ff-enabled').checked,
        starsProvider: $('#ff-stars-provider').value,
        premiumProvider: $('#ff-premium-provider').value,
        fallbackStarsProvider: $('#ff-fallback-stars-provider').value,
        fallbackPremiumProvider: $('#ff-fallback-premium-provider').value,
        maxAutoAmountUsdt: Number($('#ff-max-amount').value) || 0,
        maxAttempts: Number($('#ff-max-attempts').value) || 3,
    };
    try {
        const data = await api('/api/admin/fulfillment/settings', {
            method: 'PUT',
            body: JSON.stringify(body),
        });
        if (!data.success) throw new Error(data.error || 'Save failed');
        Toast.show('Fulfillment settings saved', 'success');
    } catch (err) {
        Toast.show(err.message, 'error');
    }
}

async function checkFulfillmentHealth() {
    const target = $('#ff-health-table');
    if (target) target.innerHTML = '<div class="text-muted small">Checking…</div>';
    try {
        const res = await fetch('/api/admin/fulfillment/health', { credentials: 'same-origin' });
        const data = await res.json();
        if (!data.success) throw new Error(data.error || 'Failed');
        const rows = Object.entries(data.health).map(([id, h]) => `
            <tr>
                <td><code>${escapeHtml(id)}</code></td>
                <td>${h.ok ? '<span class="badge text-bg-success">OK</span>' : '<span class="badge text-bg-danger">FAIL</span>'}</td>
                <td>${h.balance != null ? escapeHtml(String(h.balance)) + ' ' + escapeHtml(h.currency || '') : '—'}</td>
                <td class="small text-muted">${escapeHtml(h.error || h.info || '')}</td>
            </tr>`).join('');
        target.innerHTML = `<table class="table table-sm align-middle mb-0"><thead><tr><th>Provider</th><th>Status</th><th>Balance</th><th>Notes</th></tr></thead><tbody>${rows}</tbody></table>`;
    } catch (err) {
        target.innerHTML = `<div class="text-danger small">${escapeHtml(err.message)}</div>`;
    }
}

async function loadFulfillmentLogs() {
    const orderId = $('#ff-log-order-id')?.value?.trim();
    if (!orderId) {
        Toast.show('Please enter an order ID', 'warning');
        return;
    }
    const target = $('#ff-logs-display');
    if (target) target.innerHTML = '<div class="text-muted">Loading…</div>';
    try {
        const data = await api(`/api/admin/orders/${orderId}/details`);
        if (!data.success) throw new Error(data.error || 'Not found');
        const order = data.order;
        let html = `<div class="mb-2"><strong>Order ${escapeHtml(order.id)}</strong></div>`;
        html += `<div class="small mb-2"><code>Status: ${escapeHtml(order.status)} | Type: ${order.isPremium ? 'Premium' : (order.stars ? 'Stars' : 'Unknown')}</code></div>`;
        
        if (order.fulfillmentLog && order.fulfillmentLog.length > 0) {
            html += `<div class="mt-2"><strong>Activity:</strong></div>`;
            html += '<table class="table table-sm mb-0"><tbody>';
            order.fulfillmentLog.forEach(entry => {
                const time = new Date(entry.timestamp).toLocaleString();
                const levelBadge = {
                    'info': '<span class="badge text-bg-info">INFO</span>',
                    'success': '<span class="badge text-bg-success">SUCCESS</span>',
                    'error': '<span class="badge text-bg-danger">ERROR</span>',
                    'warning': '<span class="badge text-bg-warning">WARNING</span>'
                }[entry.level] || `<span class="badge text-bg-secondary">${escapeHtml(entry.level)}</span>`;
                html += `<tr><td class="text-muted small">${time}</td><td class="text-muted small">${levelBadge}</td><td class="small">${escapeHtml(entry.message)}</td></tr>`;
            });
            html += '</tbody></table>';
        } else {
            html += '<div class="text-muted small mt-2">No fulfillment activity yet.</div>';
        }
        
        if (target) target.innerHTML = html;
    } catch (err) {
        if (target) target.innerHTML = `<div class="text-danger small">${escapeHtml(err.message)}</div>`;
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
    $('#logout-btn')?.addEventListener('click', async () => {
        try { await fetch('/api/admin/logout', { method: 'POST', credentials: 'same-origin' }); } catch {}
        Auth.clear(); location.reload();
    });
    $('#sessions-refresh')?.addEventListener('click', loadSessions);
    $('#ff-refresh')?.addEventListener('click', loadFulfillment);
    $('#ff-save')?.addEventListener('click', saveFulfillment);
    $('#ff-health')?.addEventListener('click', checkFulfillmentHealth);
    $('#ff-logs-refresh')?.addEventListener('click', loadFulfillmentLogs);
    $('#ff-log-fetch')?.addEventListener('click', loadFulfillmentLogs);
    $('#ff-log-order-id')?.addEventListener('keydown', e => { if (e.key === 'Enter') loadFulfillmentLogs(); });
    $('#dm-send')?.addEventListener('click', sendDm);
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
    $$('[data-target-group]').forEach(b => b.addEventListener('click', () => {
        broadcastState.selectedGroup = b.dataset.targetGroup;
        updateTargetGroupButtons();
    }));
    $('#notify-clear')?.addEventListener('click', () => {
        $('#notify-message').value = '';
        $('#notify-len').textContent = '0';
        broadcastState.selectedGroup = null;
        $('#broadcast-selected').style.display = 'none';
        updateTargetGroupButtons();
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
        const dm = e.target.closest('[data-user-dm]');
        if (dm) openDmModal(dm.dataset.userDm);
        const bn = e.target.closest('[data-user-ban]');
        if (bn) banUser(bn.dataset.userBan);
        const un = e.target.closest('[data-user-unban]');
        if (un) unbanUser(un.dataset.userUnban);
        const ab = e.target.closest('[data-user-balance]');
        if (ab) adjustBalance(ab.dataset.userBalance);
        const au = e.target.closest('[data-user-audit]');
        if (au) auditUserBalance(au.dataset.userAudit);
        const rp = e.target.closest('[data-user-repair]');
        if (rp) repairUserReferrals(rp.dataset.userRepair);
        const dg = e.target.closest('[data-user-diagnose]');
        if (dg) diagnoseUser(dg.dataset.userDiagnose);
        const uv = e.target.closest('[data-user-view]');
        if (uv) viewUser(uv.dataset.userView);
        const ts = e.target.closest('[data-session-terminate]');
        if (ts) terminateSession(ts.dataset.sessionTerminate);
    });

    window.addEventListener('resize', () => Object.values(charts).forEach(c => c?.resize?.()));
}

// ---------------------- Boot ----------------------
async function enterApp() {
    hideLogin();
    $('#admin-name').textContent = TOKEN ? `Admin ${TOKEN}` : 'Admin';
    switchView('dashboard');
    startIdleTracking();
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
