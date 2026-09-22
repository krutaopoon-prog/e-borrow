/**
 * cart.js — ตะกร้าเก็บใน localStorage (ยังไม่จองสต็อกจนกว่าจะกดส่งคำขอ)
 */

const Cart = (() => {

  function read() {
    try {
      const raw = localStorage.getItem(CONFIG.CART_KEY);
      const parsed = raw ? JSON.parse(raw) : [];
      return Array.isArray(parsed) ? parsed : [];
    } catch { return []; }
  }

  function save(lines) {
    try { localStorage.setItem(CONFIG.CART_KEY, JSON.stringify(lines)); } catch {}
    document.dispatchEvent(new CustomEvent('cart:changed', { detail: lines }));
  }

  function add(item, qty = 1) {
    const lines = read();
    const existing = lines.find(l => l.item_id === item.item_id);
    const max = item.max_per_borrow > 0 ? item.max_per_borrow : Infinity;
    const limit = Math.min(max, item.available_qty);

    if (existing) {
      existing.qty = Math.min(limit, existing.qty + qty);
    } else {
      lines.push({
        item_id: item.item_id,
        name_th: item.name_th,
        unit: item.unit,
        photo_url: item.photo_url,
        is_consumable: item.is_consumable,
        available_qty: item.available_qty,
        max_per_borrow: item.max_per_borrow,
        qty: Math.min(limit, qty)
      });
    }
    save(lines);
    return read();
  }

  function setQty(itemId, qty) {
    const lines = read();
    const line = lines.find(l => l.item_id === itemId);
    if (!line) return read();

    if (qty <= 0) return remove(itemId);

    const max = line.max_per_borrow > 0 ? line.max_per_borrow : Infinity;
    line.qty = Math.min(Math.min(max, line.available_qty), qty);
    save(lines);
    return read();
  }

  function remove(itemId) {
    save(read().filter(l => l.item_id !== itemId));
    return read();
  }

  function clear() { save([]); }

  const count = () => read().reduce((n, l) => n + l.qty, 0);
  const lineCount = () => read().length;
  const has = itemId => read().some(l => l.item_id === itemId);
  const qtyOf = itemId => read().find(l => l.item_id === itemId)?.qty || 0;

  /** แปลงเป็น payload สำหรับ submitRequest */
  const toPayload = () => read().map(l => ({ item_id: l.item_id, qty: l.qty }));

  /** อัปเดตจำนวนคงเหลือจากแคตตาล็อกล่าสุด — ของอาจถูกคนอื่นยืมไปแล้ว */
  function reconcile(catalogItems) {
    const byId = {};
    catalogItems.forEach(i => { byId[i.item_id] = i; });

    const lines = read();
    const changes = [];
    const kept = [];

    lines.forEach(l => {
      const item = byId[l.item_id];
      if (!item) {
        changes.push(`${l.name_th} ไม่มีให้ยืมแล้ว`);
        return;
      }
      l.available_qty = item.available_qty;
      l.max_per_borrow = item.max_per_borrow;
      l.photo_url = item.photo_url;

      if (item.available_qty <= 0) {
        changes.push(`${l.name_th} หมดแล้ว`);
        return;
      }
      if (l.qty > item.available_qty) {
        changes.push(`${l.name_th} เหลือ ${item.available_qty} ${l.unit}`);
        l.qty = item.available_qty;
      }
      kept.push(l);
    });

    if (changes.length) save(kept);
    return changes;
  }

  return { read, add, setQty, remove, clear, count, lineCount, has, qtyOf, toPayload, reconcile };
})();
