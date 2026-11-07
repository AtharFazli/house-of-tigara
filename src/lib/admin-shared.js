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
