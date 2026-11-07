// Pure helpers shared by the admin dashboard (browser) and the server.
// No node: imports here, so this module is safe to bundle for the client.

export const ORDER_STATUSES = ['menunggu pembayaran', 'sudah dibayar', 'siap diambil', 'selesai', 'batal'];

// One step forward, one step back, and the two cancellation entries.
// Mirrors the whitelist inside public.admin_set_order_status in phase3_admin_patch.sql.
export const TRANSITIONS = {
  'menunggu pembayaran': ['sudah dibayar', 'batal'],
  'sudah dibayar': ['siap diambil', 'menunggu pembayaran', 'batal'],
  'siap diambil': ['selesai', 'sudah dibayar'],
  'selesai': ['siap diambil'],
  'batal': [],
};

export function allowedTransitions(fromStatus) {
  return TRANSITIONS[fromStatus] ?? [];
}

export function canTransition(fromStatus, toStatus) {
  return allowedTransitions(fromStatus).includes(toStatus);
}

export function isOrderOrderId(value) {
  return typeof value === 'string' && /^TIG-[0-9]+$/.test(value);
}

export function maskContact(contact) {
  const value = String(contact ?? '');
  if (value.length <= 7) return '***';
  return `${value.slice(0, 4)}*****${value.slice(-3)}`;
}

// The buyer fills in the "[isi]" parts in WhatsApp. The dashboard never reads
// pickup_date or pickup_note.
export function buildAdminChatMessage({ nama, orderId }) {
  const name = String(nama ?? '').replace(/[*_~`]/g, '').trim() || 'pelanggan';
  return `Halo ${name}, pesanan ${orderId} sudah kami terima. Jadwal pickup: [isi]. Catatan: [isi].`;
}

export function buildWaLink(contact, message) {
  const number = String(contact ?? '').replace(/[^\d]/g, '');
  return `https://wa.me/${number}?text=${encodeURIComponent(message)}`;
}

export function summarizeItems(items) {
  return (items ?? [])
    .map((item) => `${item.product_name}${item.variant ? ` ${item.variant}` : ''} x${item.quantity}`)
    .join(', ');
}

export function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const WIB_TZ = 'Asia/Jakarta';
const WIB_CLOCK = new Intl.DateTimeFormat('id-ID', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: WIB_TZ });
const WIB_DATE = new Intl.DateTimeFormat('id-ID', { day: '2-digit', month: 'short', timeZone: WIB_TZ });
const WIB_DAY_KEY = new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit', timeZone: WIB_TZ });

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const STALE_HOURS = 3;

function toDate(value) {
  if (value === null || value === undefined || value === '') return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function jakartaClock(value) {
  const date = toDate(value);
  return date ? WIB_CLOCK.format(date) : '-';
}

export function formatRelativeTime(value, now = Date.now()) {
  const date = toDate(value);
  if (!date) return '-';
  const diff = now - date.getTime();
  if (diff < MINUTE_MS) return 'baru saja';
  if (diff < HOUR_MS) return `${Math.floor(diff / MINUTE_MS)} menit lalu`;
  if (WIB_DAY_KEY.format(date) === WIB_DAY_KEY.format(new Date(now))) return `${Math.floor(diff / HOUR_MS)} jam lalu`;
  if (diff < 2 * DAY_MS) return `kemarin ${jakartaClock(date)}`;
  if (diff < 7 * DAY_MS) return `${Math.floor(diff / DAY_MS)} hari lalu`;
  return WIB_DATE.format(date);
}

export function isStale(value, hours = STALE_HOURS) {
  const date = toDate(value);
  if (!date) return false;
  return Date.now() - date.getTime() > hours * HOUR_MS;
}

// One entry per in-flight action, so a double tap cannot fire the same
// transition twice.
export function createActionGuard() {
  const busy = new Set();
  return {
    isBusy: (key) => busy.has(key),
    begin(key) {
      if (busy.has(key)) return false;
      busy.add(key);
      return true;
    },
    end(key) {
      busy.delete(key);
    },
  };
}
