/* Admin Panel JS - minimal scaffold wired to existing backend */
(function(){
  const BASE = window.location.origin;
  const API = BASE + '/api';

  const qs = (s) => document.querySelector(s);
  const qsa = (s) => Array.from(document.querySelectorAll(s));

  const state = {
    authed: false,
    adminId: localStorage.getItem('admin_tg') || '',
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
      const tg = localStorage.getItem('admin_tg') || state.adminId;
      if (!tg) throw new Error('No Telegram ID');
      const res = await fetch(API + '/me', { headers: { 'x-telegram-id': tg }});
      const data = await res.json();
      if (!res.ok || !data.isAdmin) throw new Error('Not admin');
      state.authed = true;
      state.adminId = tg;
      localStorage.setItem('admin_tg', tg);
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
      const res = await fetch(API + '/admin/orders?limit=50', { headers: { 'x-telegram-id': state.adminId }});
      const data = await res.json();
      qs('#ordersCount').textContent = (data.orders?.length || 0) + ' items';
      const rows = (data.orders || []).map(o => [
        o.id,
        o.type || '-',
        o.username ? '@'+o.username : o.telegramId,
        (o.amount || 0) + ' USDT',
        o.status,
        new Date(o.dateCreated || o.createdAt || Date.now()).toLocaleString(),
      ]);
      qs('#ordersTable').innerHTML = table(['Order ID','Type','User','Amount','Status','Created'], rows);
    } catch {}
  }

  async function loadWithdrawals(){
    try {
      const res = await fetch(API + '/admin/withdrawals?limit=50', { headers: { 'x-telegram-id': state.adminId }});
      const data = await res.json();
      qs('#withdrawalsCount').textContent = (data.withdrawals?.length || 0) + ' items';
      const rows = (data.withdrawals || []).map(w => [
        'WD' + (w._id || '').toString().slice(-8).toUpperCase(),
        (w.amount || 0) + ' USDT',
        w.walletAddress,
        w.status,
        w.username ? '@'+w.username : w.userId,
        new Date(w.createdAt || Date.now()).toLocaleString(),
      ]);
      qs('#withdrawalsTable').innerHTML = table(['WDID','Amount','Wallet','Status','User','Created'], rows);
    } catch {}
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
  }

  function wireAuth(){
    qs('#loginBtn').addEventListener('click', () => {
      const tg = qs('#tgIdInput').value.trim();
      if (!tg) return;
      localStorage.setItem('admin_tg', tg);
      checkAuth();
    });
    qs('#logoutBtn').addEventListener('click', () => {
      localStorage.removeItem('admin_tg');
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

