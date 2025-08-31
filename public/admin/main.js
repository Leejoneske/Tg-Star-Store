/* Admin Panel JS - minimal scaffold wired to existing backend */
(function(){
  const BASE = window.location.origin;
  const API = BASE + '/api';

  const qs = (s) => document.querySelector(s);
  const qsa = (s) => Array.from(document.querySelectorAll(s));

  const state = {
    authed: false,
    adminId: localStorage.getItem('admin_tg') || '',
    orders: { page: 1, limit: 20, total: 0, status: '', q: '' },
    withdrawals: { page: 1, limit: 20, total: 0, status: '', q: '' },
  };

  function show(sectionId){
    qsa('main > section').forEach(sec => sec.classList.add('hidden'));
    const el = qs('#' + sectionId);
    if (el) el.classList.remove('hidden');
  }

  function setActiveNav(view){
    qsa('.nav-link').forEach(b => b.classList.toggle('bg-gray-100', b.dataset.view === view));
  }

  function guard(on){
    if (on) { show('guard'); } else { qs('#guard').classList.add('hidden'); }
  }

  async function checkAuth(){
    try {
      const res = await fetch(API + '/me', { credentials: 'include' });
      const data = await res.json();
      if (!res.ok || !data.isAdmin) throw new Error('Not admin');
      state.authed = true;
      state.adminId = data.id;
      guard(false);
      show('dashboard');
      setActiveNav('dashboard');
      await Promise.all([loadStats(), loadOrders(), loadWithdrawals()]);
    } catch (e) {
      state.authed = false;
      guard(true);
      qs('#guardMsg').textContent = 'Access denied';
      qs('#guardMsg').classList.remove('hidden');
    }
  }

  async function sendOtp(tgId){
    const res = await fetch(API + '/admin/auth/send-otp', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tgId }) });
    if (!res.ok) {
      const d = await res.json().catch(()=>({}));
      throw new Error(d.error || 'Failed to send code');
    }
  }

  async function verifyOtp(tgId, code){
    const res = await fetch(API + '/admin/auth/verify-otp', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tgId, code }), credentials: 'include' });
    const d = await res.json().catch(()=>({}));
    if (!res.ok || !d.success) throw new Error(d.error || 'Invalid code');
  }

  async function loadStats(){
    try {
      const res = await fetch(API + '/admin/stats', { headers: { 'x-telegram-id': state.adminId }});
      const data = await res.json();
      const stats = [
        { label: 'Total Orders', value: data.totalOrders || 0 },
        { label: 'Pending Withdrawals', value: data.pendingWithdrawals || 0 },
        { label: 'Users', value: data.totalUsers || 0 },
        { label: 'Revenue (USDT)', value: (data.revenueUsdt || 0).toFixed(2) },
      ];
      const wrap = qs('#stats');
      wrap.innerHTML = stats.map(s => `
        <div class="p-4 bg-gray-50 border rounded">
          <div class="text-sm text-gray-500">${s.label}</div>
          <div class="text-2xl font-semibold mt-1">${s.value}</div>
        </div>`).join('');
    } catch {}
  }

  function table(headers, rows){
    return `<table class="min-w-full text-sm">
      <thead><tr>${headers.map(h=>`<th class="text-left p-2 border-b">${h}</th>`).join('')}</tr></thead>
      <tbody>${rows.map(r=>`<tr>${r.map(c=>`<td class="p-2 border-b align-top">${c}</td>`).join('')}</tr>`).join('')}</tbody>
    </table>`;
  }

  async function loadOrders(){
    try {
      state.orders.status = (qs('#ordersStatus')?.value || '').trim();
      state.orders.q = (qs('#ordersQuery')?.value || '').trim();
      const params = new URLSearchParams({ limit: String(state.orders.limit), page: String(state.orders.page) });
      if (state.orders.status) params.set('status', state.orders.status);
      if (state.orders.q) params.set('q', state.orders.q);
      const res = await fetch(API + '/admin/orders?' + params.toString(), { credentials: 'include' });
      const data = await res.json();
      state.orders.total = data.total || (data.orders?.length || 0);
      qs('#ordersCount').textContent = `${data.orders?.length || 0} / ${state.orders.total}`;
      const pageEl = qs('#ordersPage'); if (pageEl) pageEl.textContent = String(state.orders.page);
      const rows = (data.orders || []).map(o => {
        const badge = o.status === 'completed' ? '<span class="px-2 py-0.5 text-xs rounded bg-green-100 text-green-700">Completed</span>' :
                      o.status === 'pending' ? '<span class="px-2 py-0.5 text-xs rounded bg-yellow-100 text-yellow-700">Pending</span>' :
                      o.status === 'processing' ? '<span class="px-2 py-0.5 text-xs rounded bg-blue-100 text-blue-700">Processing</span>' :
                      o.status === 'refunded' ? '<span class="px-2 py-0.5 text-xs rounded bg-purple-100 text-purple-700">Refunded</span>' :
                      '<span class="px-2 py-0.5 text-xs rounded bg-red-100 text-red-700">' + (o.status || 'Declined') + '</span>';
        const actions = (o.status === 'pending' || o.status === 'processing') ? `
          <div class="space-x-2">
            <button class="px-2 py-1 text-xs bg-green-600 text-white rounded" data-act="ord-complete" data-id="${o.id}">Complete</button>
            ${o.type === 'sell' ? `<button class=\"px-2 py-1 text-xs bg-yellow-600 text-white rounded\" data-act=\"ord-refund\" data-id=\"${o.id}\">Refund</button>` : ''}
            <button class="px-2 py-1 text-xs bg-red-600 text-white rounded" data-act="ord-decline" data-id="${o.id}">Decline</button>
          </div>` : `<span class="text-gray-400 text-xs">—</span>`;
        return [
          o.id,
          o.type || '-',
          o.username ? '@'+o.username : o.telegramId,
          (o.amount || 0) + ' USDT',
          badge,
          new Date(o.dateCreated || o.createdAt || Date.now()).toLocaleString(),
          actions
        ];
      });
      qs('#ordersTable').innerHTML = table(['Order ID','Type','User','Amount','Status','Created','Actions'], rows);
      wireOrderActions();
    } catch {}
  }

  function wireOrderActions(){
    qsa('[data-act="ord-complete"]').forEach(b => b.addEventListener('click', async () => {
      const id = b.dataset.id;
      b.disabled = true;
      await fetch(API + `/admin/orders/${id}/complete`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-telegram-id': state.adminId }});
      await loadOrders();
    }));
    qsa('[data-act="ord-decline"]').forEach(b => b.addEventListener('click', async () => {
      const id = b.dataset.id;
      b.disabled = true;
      await fetch(API + `/admin/orders/${id}/decline`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-telegram-id': state.adminId }});
      await loadOrders();
    }));
    qsa('[data-act="ord-refund"]').forEach(b => b.addEventListener('click', async () => {
      const id = b.dataset.id;
      b.disabled = true;
      await fetch(API + `/admin/orders/${id}/refund`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-telegram-id': state.adminId }});
      await loadOrders();
    }));
  }

  async function loadWithdrawals(){
    try {
      state.withdrawals.status = (qs('#withdrawalsStatus')?.value || '').trim();
      state.withdrawals.q = (qs('#withdrawalsQuery')?.value || '').trim();
      const params = new URLSearchParams({ limit: String(state.withdrawals.limit), page: String(state.withdrawals.page) });
      if (state.withdrawals.status) params.set('status', state.withdrawals.status);
      if (state.withdrawals.q) params.set('q', state.withdrawals.q);
      const res = await fetch(API + '/admin/withdrawals?' + params.toString(), { credentials: 'include' });
      const data = await res.json();
      state.withdrawals.total = data.total || (data.withdrawals?.length || 0);
      qs('#withdrawalsCount').textContent = `${data.withdrawals?.length || 0} / ${state.withdrawals.total}`;
      const pageEl = qs('#withdrawalsPage'); if (pageEl) pageEl.textContent = String(state.withdrawals.page);
      const rows = (data.withdrawals || []).map(w => {
        const wdId = 'WD' + (w._id || '').toString().slice(-8).toUpperCase();
        const badge = w.status === 'completed' ? '<span class="px-2 py-0.5 text-xs rounded bg-green-100 text-green-700">Completed</span>' :
                      w.status === 'pending' ? '<span class="px-2 py-0.5 text-xs rounded bg-yellow-100 text-yellow-700">Pending</span>' :
                      '<span class="px-2 py-0.5 text-xs rounded bg-red-100 text-red-700">Declined</span>';
        const actions = w.status === 'pending' ? `
          <div class="space-x-2">
            <button class="px-2 py-1 text-xs bg-green-600 text-white rounded" data-act="wd-complete" data-id="${w._id}">Complete</button>
            <div class="inline-block relative">
              <button class="px-2 py-1 text-xs bg-red-600 text-white rounded" data-act="wd-decline" data-id="${w._id}">Decline</button>
              <select class="ml-2 text-xs border rounded px-1 py-1 align-middle" data-act="wd-reason" data-id="${w._id}">
                <option value="" disabled selected>Reason…</option>
                <option value="Wrong wallet address">Wrong wallet address</option>
                <option value="Not approved">Not approved</option>
                <option value="Other">Other</option>
              </select>
            </div>
          </div>` : `<span class="text-gray-400 text-xs">—</span>`;
        return [
          wdId,
          (w.amount || 0) + ' USDT',
          w.walletAddress,
          badge + (w.declineReason ? ` <span class=\"text-gray-500\">(${w.declineReason})</span>` : ''),
          (w.username ? '@'+w.username : w.userId),
          new Date(w.createdAt || Date.now()).toLocaleString(),
          actions
        ];
      });
      qs('#withdrawalsTable').innerHTML = table(['WDID','Amount','Wallet','Status','User','Created','Actions'], rows);
      wireWithdrawalActions();
    } catch {}
  }

  function wireWithdrawalActions(){
    qsa('[data-act="wd-complete"]').forEach(b => b.addEventListener('click', async () => {
      const id = b.dataset.id;
      b.disabled = true;
      await fetch(API + `/admin/withdrawals/${id}/complete`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-telegram-id': state.adminId }});
      await loadWithdrawals();
    }));
    qsa('[data-act="wd-decline"]').forEach(b => b.addEventListener('click', async () => {
      const id = b.dataset.id;
      const reasonSel = document.querySelector(`select[data-act="wd-reason"][data-id="${id}"]`);
      const reason = reasonSel && reasonSel.value ? reasonSel.value : 'Declined';
      b.disabled = true;
      await fetch(API + `/admin/withdrawals/${id}/decline`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-telegram-id': state.adminId }, body: JSON.stringify({ reason }) });
      await loadWithdrawals();
    }));
  }

  function wireNav(){
    qsa('.nav-link').forEach(b => b.addEventListener('click', async (e) => {
      const view = b.dataset.view;
      setActiveNav(view);
      show(view);
      if (view === 'dashboard') loadStats();
      if (view === 'orders') loadOrders();
      if (view === 'withdrawals') loadWithdrawals();
    }));
    const os = qs('#ordersStatus'); if (os) os.addEventListener('change', () => { state.orders.page = 1; loadOrders(); });
    const oq = qs('#ordersQuery'); if (oq) oq.addEventListener('keyup', (e) => { if (e.key === 'Enter') { state.orders.page = 1; loadOrders(); }});
    const op = qs('#ordersPrev'); if (op) op.addEventListener('click', () => { state.orders.page = Math.max(1, state.orders.page - 1); loadOrders(); });
    const on = qs('#ordersNext'); if (on) on.addEventListener('click', () => { const max = Math.max(1, Math.ceil(state.orders.total / state.orders.limit)); state.orders.page = Math.min(max, state.orders.page + 1); loadOrders(); });
    const ws = qs('#withdrawalsStatus'); if (ws) ws.addEventListener('change', () => { state.withdrawals.page = 1; loadWithdrawals(); });
    const wq = qs('#withdrawalsQuery'); if (wq) wq.addEventListener('keyup', (e) => { if (e.key === 'Enter') { state.withdrawals.page = 1; loadWithdrawals(); }});
    const wp = qs('#withdrawalsPrev'); if (wp) wp.addEventListener('click', () => { state.withdrawals.page = Math.max(1, state.withdrawals.page - 1); loadWithdrawals(); });
    const wn = qs('#withdrawalsNext'); if (wn) wn.addEventListener('click', () => { const max = Math.max(1, Math.ceil(state.withdrawals.total / state.withdrawals.limit)); state.withdrawals.page = Math.min(max, state.withdrawals.page + 1); loadWithdrawals(); });
    const gs = qs('#globalSearch'); if (gs) gs.addEventListener('keyup', (e) => { if (e.key === 'Enter') { const q = gs.value.trim(); const oqi = qs('#ordersQuery'); if (oqi) oqi.value = q; const wqi = qs('#withdrawalsQuery'); if (wqi) wqi.value = q; state.orders.page = 1; state.withdrawals.page = 1; loadOrders(); loadWithdrawals(); }});
    const exo = qs('#globalExportOrders'); if (exo) exo.addEventListener('click', () => {
      const s = state.orders.status ? `&status=${encodeURIComponent(state.orders.status)}` : '';
      const q = state.orders.q ? `&q=${encodeURIComponent(state.orders.q)}` : '';
      window.open(API + '/admin/orders/export?limit=5000' + s + q, '_blank');
    });
    const exw = qs('#globalExportWithdrawals'); if (exw) exw.addEventListener('click', () => {
      const s = state.withdrawals.status ? `&status=${encodeURIComponent(state.withdrawals.status)}` : '';
      const q = state.withdrawals.q ? `&q=${encodeURIComponent(state.withdrawals.q)}` : '';
      window.open(API + '/admin/withdrawals/export?limit=5000' + s + q, '_blank');
    });
  }

  function wireAuth(){
    qs('#sendOtpBtn').addEventListener('click', async () => {
      const tg = qs('#tgIdInput').value.trim();
      if (!tg) { qs('#guardMsg').textContent = 'Enter your Telegram ID'; qs('#guardMsg').classList.remove('hidden'); return; }
      qs('#guardMsg').classList.add('hidden');
      try {
        await sendOtp(tg);
        qs('#guardMsg').textContent = 'Code sent. Check your Telegram.';
        qs('#guardMsg').classList.remove('hidden');
        let left = 60; const timer = qs('#otpTimer');
        if (timer) { timer.classList.remove('hidden'); timer.textContent = `${left}s`; }
        const iv = setInterval(() => { left -= 1; if (left <= 0) { clearInterval(iv); if (timer) timer.classList.add('hidden'); } else if (timer) { timer.textContent = `${left}s`; } }, 1000);
      }
      catch (e) { qs('#guardMsg').textContent = e.message; qs('#guardMsg').classList.remove('hidden'); }
    });
    qs('#verifyOtpBtn').addEventListener('click', async () => {
      const tg = qs('#tgIdInput').value.trim();
      const code = qs('#otpInput').value.trim();
      if (!tg || !code) { qs('#guardMsg').textContent = 'Enter Telegram ID and the code'; qs('#guardMsg').classList.remove('hidden'); return; }
      qs('#guardMsg').classList.add('hidden');
      try { await verifyOtp(tg, code); await checkAuth(); }
      catch (e) { qs('#guardMsg').textContent = e.message; qs('#guardMsg').classList.remove('hidden'); }
    });
    qs('#logoutBtn').addEventListener('click', async () => {
      await fetch(API + '/admin/logout', { method: 'POST', credentials: 'include' });
      state.authed = false;
      guard(true);
      show('guard');
    });
    qs('#refreshBtn').addEventListener('click', async () => {
      const current = qsa('main > section').find(s => !s.classList.contains('hidden'))?.id;
      if (current === 'dashboard') loadStats();
      if (current === 'orders') loadOrders();
      if (current === 'withdrawals') loadWithdrawals();
    });
  }

  document.addEventListener('DOMContentLoaded', () => {
    wireNav();
    wireAuth();
    checkAuth();
  });
})();

