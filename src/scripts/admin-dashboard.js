import { formatRupiah } from '../lib/order-input.js';
import {
  ORDER_STATUSES,
  allowedTransitions,
  buildAdminChatMessage,
  buildWaLink,
  createActionGuard,
  escapeHtml,
  formatRelativeTime,
  isStale,
  summarizeItems,
} from '../lib/admin-shared.js';

const REFRESH_MS = 30000;
const TABS = ['semua', ...ORDER_STATUSES];
const TAB_LABELS = { semua: 'Semua', 'menunggu pembayaran': 'Menunggu', 'sudah dibayar': 'Dibayar', 'siap diambil': 'Siap', selesai: 'Selesai', batal: 'Batal' };
const ACTION_LABELS = { 'sudah dibayar': 'Tandai dibayar', 'siap diambil': 'Siap diambil', selesai: 'Selesai', batal: 'Batal' };

function actionLabel(fromStatus, toStatus) {
  if (toStatus === 'batal') return 'Batal';
  if (ORDER_STATUSES.indexOf(toStatus) < ORDER_STATUSES.indexOf(fromStatus)) {
    return `Kembalikan ke ${toStatus}`;
  }
  return ACTION_LABELS[toStatus] ?? toStatus;
}

const QUICK_TRANSITIONS = {
  'menunggu pembayaran': 'sudah dibayar',
  'sudah dibayar': 'siap diambil',
  'siap diambil': 'selesai',
};

const state = { status: '', q: '', orders: [], counts: {}, detail: null, timer: null, pending: new Set() };

const tabsEl = document.querySelector('[data-tabs]');
const listEl = document.querySelector('[data-list]');
const detailEl = document.querySelector('[data-detail]');
const recapEl = document.querySelector('[data-recap]');
const searchEl = document.querySelector('[data-search]');
const countTotalEl = document.querySelector('[data-count-total]');
const refreshEl = document.querySelector('[data-refresh]');
const logoutEl = document.querySelector('[data-logout]');

const guard = createActionGuard();
let toastTimer;

function toast(message, type = 'info') {
  const el = document.querySelector('[data-toast]');
  if (!el) return;
  el.textContent = message;
  el.className = `admin-toast admin-toast-${type}`;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 3200);
}

function formatDateTime(value) {
  if (!value) return '-';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '-';
  return date.toLocaleString('id-ID', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
}

function slug(value) {
  return String(value).replace(/\s+/g, '-');
}

// One retry on 401: another tab may have just rotated the cookie. A second
// 401 means the session really is gone.
async function api(path, options = {}) {
  const config = {
    headers: { 'content-type': 'application/json', 'x-requested-with': 'xmlhttprequest', ...(options.headers || {}) },
    ...options,
  };
  let response = await fetch(path, config);
  if (response.status === 401) {
    response = await fetch(path, config);
    if (response.status === 401) {
      window.location.href = '/admin/login';
      return null;
    }
  }
  return response;
}

async function loadList() {
  const response = await api('/api/admin/orders', {
    method: 'POST',
    body: JSON.stringify({ status: state.status, q: state.q }),
  });
  if (!response) return;
  const result = await response.json().catch(() => null);
  if (!result) return;
  state.orders = result.orders ?? [];
  state.counts = result.counts ?? {};
  renderTabs();
  renderList();
}

async function loadRecap() {
  const response = await api('/api/admin/recap');
  if (!response) return;
  const result = await response.json().catch(() => null);
  if (!result) return;
  const recap = result.recap;
  recapEl.innerHTML = `
    <table class="admin-table">
      <thead><tr><th>Produk</th><th>Varian</th><th>Pcs</th><th>Rupiah</th></tr></thead>
      <tbody>
        ${recap.perProduct.map((row) => `
          <tr>
            <td>${escapeHtml(row.product_name)}</td>
            <td>${escapeHtml(row.variant ?? '-')}</td>
            <td>${row.quantity}</td>
            <td>${formatRupiah(row.subtotal)}</td>
          </tr>`).join('')}
      </tbody>
    </table>
    <div class="admin-recap-totals">
      ${Object.entries(recap.perStatus).map(([status, total]) => `
        <p><span>${status}</span><strong>${formatRupiah(total)}</strong></p>`).join('')}
    </div>`;
}

function renderTabs() {
  const total = Object.values(state.counts).reduce((sum, count) => sum + count, 0);
  tabsEl.innerHTML = TABS.map((tab) => {
    const active = state.status === tab ? ' active' : '';
    const count = tab === 'semua' ? total : (state.counts[tab] ?? 0);
    return `<button class="admin-tab${active}" type="button" data-tab="${tab}">${TAB_LABELS[tab]}<span class="admin-tab-count">${count}</span></button>`;
  }).join('');
}

function renderList() {
  countTotalEl.textContent = state.orders.length;
  if (!state.orders.length) {
    listEl.innerHTML = '<p class="admin-empty">Tidak ada order pada tab ini.</p>';
    return;
  }
  listEl.innerHTML = state.orders.map((order) => {
    const stale = isStale(order.created_at);
    const quick = QUICK_TRANSITIONS[order.status];
    const quickPending = quick ? state.pending.has(`${order.id}:${quick}`) : false;
    return `
    <div class="admin-order${stale ? ' admin-order-stale' : ''}">
      <button class="admin-order-main" type="button" data-order-id="${escapeHtml(order.id)}">
        <span class="admin-order-total">${formatRupiah(order.total)}</span>
        <span class="admin-badge admin-badge-${slug(order.status)}">${order.status}</span>
        <span class="admin-order-id">${escapeHtml(order.id)}</span>
        <span class="admin-order-name">${escapeHtml(order.customer_name)}</span>
        <span class="admin-order-time">${formatRelativeTime(order.created_at)}${stale ? ' · <span class="admin-order-stale-dot">lama</span>' : ''}</span>
        <span class="admin-order-items">${escapeHtml(summarizeItems(order.order_items))}</span>
      </button>
      ${quick ? `<div class="admin-order-actions"><button class="btn btn-primary" type="button" data-quick="${quick}" data-quick-id="${escapeHtml(order.id)}"${quickPending ? ' disabled' : ''}>${quickPending ? 'Memproses...' : actionLabel(order.status, quick)}</button></div>` : ''}
    </div>`;
  }).join('');
}

async function openDetail(orderId) {
  const response = await api(`/api/admin/orders/${encodeURIComponent(orderId)}`);
  if (!response) return;
  const result = await response.json().catch(() => null);
  if (!response.ok || !result) return;
  state.detail = result.order;
  renderDetail();
}

function renderDetail() {
  const order = state.detail;
  const transitions = allowedTransitions(order.status);
  detailEl.hidden = false;
  detailEl.innerHTML = `
    <div class="admin-detail-head">
      <div>
        <h2>${escapeHtml(order.id)}</h2>
        <p class="admin-muted">${escapeHtml(order.customer_name)} · ${formatRupiah(order.total)}</p>
      </div>
      <button class="btn btn-ghost" type="button" data-close-detail>Tutup</button>
    </div>
    <div class="admin-detail-grid">
      <div>
        <h3>Item</h3>
        <table class="admin-table">
          <tbody>
            ${order.items.map((item) => `
              <tr>
                <td>${escapeHtml(item.product_name)}${item.variant ? ` <span class="admin-muted">(${escapeHtml(item.variant)})</span>` : ''}</td>
                <td>x${item.quantity}</td>
                <td>${formatRupiah(item.subtotal)}</td>
              </tr>`).join('')}
          </tbody>
        </table>
      </div>
      <div>
        <h3>Info</h3>
        <p class="admin-kv"><span>Dibuat</span><strong>${formatDateTime(order.created_at)}</strong></p>
        <p class="admin-kv"><span>Dibayar</span><strong>${formatDateTime(order.paid_at)}</strong></p>
        <p class="admin-kv"><span>WhatsApp</span><strong data-contact>${escapeHtml(order.contact)}</strong></p>
        <a class="btn btn-primary" href="${buildWaLink(order.contact, buildAdminChatMessage({ nama: order.customer_name, orderId: order.id }))}" target="_blank" rel="noopener">Chat pembeli</a>
      </div>
    </div>
    <div class="admin-actions">
      ${transitions.map((to) => {
        const pending = state.pending.has(`${order.id}:${to}`);
        return `
        <button class="btn ${to === 'batal' ? 'btn-danger' : 'btn-primary'}" type="button" data-transition="${to}"${pending ? ' disabled' : ''}>
          ${pending ? 'Memproses...' : actionLabel(order.status, to)}
        </button>`;
      }).join('')}
    </div>
    <div class="admin-history">
      <h3>Riwayat</h3>
      ${order.events.length
        ? order.events.map((event) => `
          <p>${formatDateTime(event.created_at)} · ${escapeHtml(event.admin_users?.nama ?? '-')}: ${event.dari_status} → ${event.ke_status}</p>`).join('')
        : '<p class="admin-muted">Belum ada perubahan status.</p>'}
    </div>`;
  detailEl.scrollIntoView({ block: 'nearest' });
}

async function applyTransition(order, toStatus) {
  const label = actionLabel(order.status, toStatus);
  if (!window.confirm(`${label}?\n\nOrder ${order.id}\n${order.customer_name}\n${formatRupiah(order.total)}`)) return;

  const key = `${order.id}:${toStatus}`;
  if (!guard.begin(key)) return;
  state.pending.add(key);
  renderList();
  if (state.detail) renderDetail();

  let response = null;
  try {
    response = await api(`/api/admin/orders/${encodeURIComponent(order.id)}/status`, {
      method: 'POST',
      body: JSON.stringify({ from_status: order.status, to_status: toStatus }),
    });
  } catch {
    response = null;
  }

  state.pending.delete(key);
  guard.end(key);

  if (!response) {
    toast('Gagal menghubungi server.', 'error');
    return;
  }
  const result = await response.json().catch(() => ({}));

  if (response.status === 409 || result.changed === false) {
    toast(result.error || 'Status sudah berubah. Data dimuat ulang.', 'error');
    await loadList();
    if (state.detail) await openDetail(state.detail.id);
    return;
  }
  if (!response.ok) {
    toast(result.error || 'Gagal mengubah status.', 'error');
    return;
  }

  toast(`${label} untuk ${order.id} berhasil.`, 'success');
  await loadList();
  if (state.detail) await openDetail(state.detail.id);
}

tabsEl.addEventListener('click', (event) => {
  const tab = event.target.closest('[data-tab]');
  if (!tab) return;
  state.status = tab.dataset.tab === 'semua' ? '' : tab.dataset.tab;
  loadList();
});

listEl.addEventListener('click', (event) => {
  const quick = event.target.closest('[data-quick]');
  if (quick) {
    const order = state.orders.find((entry) => entry.id === quick.dataset.quickId);
    if (order) applyTransition(order, quick.dataset.quick);
    return;
  }
  const card = event.target.closest('[data-order-id]');
  if (card) openDetail(card.dataset.orderId);
});

detailEl.addEventListener('click', (event) => {
  if (event.target.closest('[data-close-detail]')) {
    detailEl.hidden = true;
    state.detail = null;
    return;
  }
  const action = event.target.closest('[data-transition]');
  if (action) applyTransition(state.detail.id, action.dataset.transition);
});

let searchTimer;
searchEl.addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    state.q = searchEl.value.trim();
    loadList();
  }, 300);
});

refreshEl.addEventListener('click', () => loadAll());
logoutEl.addEventListener('click', async () => {
  await api('/api/admin/logout', { method: 'POST' });
  window.location.href = '/admin/login';
});

async function loadAll() {
  await Promise.all([loadList(), loadRecap()]);
  if (state.detail) await openDetail(state.detail.id);
}

state.timer = window.setInterval(() => { if (!document.hidden) loadAll(); }, REFRESH_MS);
loadAll();
