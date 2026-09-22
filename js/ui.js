/**
 * ui.js — ฟังก์ชันที่ทุกหน้าใช้ร่วมกัน
 */

const UI = (() => {

  function toast(message, type = 'info', duration = 3500) {
    let host = document.querySelector('.toast-host');
    if (!host) {
      host = document.createElement('div');
      host.className = 'toast-host';
      document.body.appendChild(host);
    }
    const el = document.createElement('div');
    el.className = `toast toast--${type}`;
    el.textContent = message;
    host.appendChild(el);
    requestAnimationFrame(() => el.classList.add('is-visible'));
    setTimeout(() => {
      el.classList.remove('is-visible');
      setTimeout(() => el.remove(), 300);
    }, duration);
  }

  const error = m => toast(m, 'error', 5000);
  const success = m => toast(m, 'success');

  /** แสดง error จาก API พร้อมข้อความไทย */
  function apiError(err) {
    error(err?.messageTh || err?.message || 'เกิดข้อผิดพลาด');
  }

  function loading(show, text = 'กำลังโหลด...') {
    let el = document.querySelector('.loading-overlay');
    if (show) {
      if (!el) {
        el = document.createElement('div');
        el.className = 'loading-overlay';
        el.innerHTML = `<div class="loading-box"><div class="spinner"></div><p></p></div>`;
        document.body.appendChild(el);
      }
      el.querySelector('p').textContent = text;
      el.classList.add('is-visible');
    } else if (el) {
      el.classList.remove('is-visible');
    }
  }

  /** ปุ่มที่กดแล้วล็อกไว้ กันกดซ้ำ */
  async function withButton(btn, fn, busyText = 'กำลังดำเนินการ...') {
    if (btn.disabled) return;
    const original = btn.textContent;
    btn.disabled = true;
    btn.textContent = busyText;
    try {
      return await fn();
    } finally {
      btn.disabled = false;
      btn.textContent = original;
    }
  }

  function confirmDialog(message, confirmText = 'ยืนยัน') {
    return new Promise(resolve => {
      const el = document.createElement('div');
      el.className = 'modal-backdrop is-visible';
      el.innerHTML = `
        <div class="modal">
          <p class="modal__message"></p>
          <div class="modal__actions">
            <button class="btn btn--ghost" data-act="cancel">ยกเลิก</button>
            <button class="btn btn--primary" data-act="ok"></button>
          </div>
        </div>`;
      el.querySelector('.modal__message').textContent = message;
      el.querySelector('[data-act="ok"]').textContent = confirmText;
      document.body.appendChild(el);

      el.addEventListener('click', e => {
        if (e.target === el || e.target.dataset.act === 'cancel') {
          el.remove(); resolve(false);
        } else if (e.target.dataset.act === 'ok') {
          el.remove(); resolve(true);
        }
      });
    });
  }

  const THAI_MONTHS = ['ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.',
    'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.'];

  function formatDate(iso, withTime = true) {
    if (!iso) return '-';
    const d = new Date(iso);
    if (isNaN(d)) return '-';
    const buddhistYear = d.getFullYear() + 543;
    let s = `${d.getDate()} ${THAI_MONTHS[d.getMonth()]} ${String(buddhistYear).slice(2)}`;
    if (withTime) {
      s += ` ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')} น.`;
    }
    return s;
  }

  /** "อีก 2 วัน" / "เลยมาแล้ว 3 วัน" — อ่านง่ายกว่าวันที่ดิบ */
  function relativeDue(iso) {
    if (!iso) return { text: '-', overdue: false };
    const diff = new Date(iso) - Date.now();
    const overdue = diff < 0;
    const mins = Math.abs(Math.round(diff / 60000));
    const hours = Math.round(mins / 60);
    const days = Math.round(hours / 24);

    let text;
    if (mins < 60) text = `${mins} นาที`;
    else if (hours < 24) text = `${hours} ชั่วโมง`;
    else text = `${days} วัน`;

    return { text: overdue ? `เลยกำหนด ${text}` : `อีก ${text}`, overdue };
  }

  const STATUS_LABELS = {
    REQUESTED: { text: 'รอครูอนุมัติ', cls: 'warn' },
    APPROVED: { text: 'รอรับของ', cls: 'info' },
    REJECTED: { text: 'ถูกปฏิเสธ', cls: 'muted' },
    CANCELLED: { text: 'ยกเลิกแล้ว', cls: 'muted' },
    EXPIRED: { text: 'หมดเวลารับของ', cls: 'muted' },
    IN_USE: { text: 'กำลังยืม', cls: 'ok' },
    PARTIALLY_RETURNED: { text: 'คืนบางส่วน', cls: 'warn' },
    OVERDUE: { text: 'เกินกำหนดคืน', cls: 'danger' },
    RETURNED: { text: 'คืนแล้ว', cls: 'muted' },
    CLOSED_CONSUMED: { text: 'รับของสิ้นเปลืองแล้ว', cls: 'muted' },
    LOST: { text: 'สูญหาย', cls: 'danger' }
  };

  function statusBadge(status) {
    const s = STATUS_LABELS[status] || { text: status, cls: 'muted' };
    return `<span class="badge badge--${s.cls}">${s.text}</span>`;
  }

  /** กัน XSS — ชื่ออุปกรณ์กับชื่อคนมาจาก input ของผู้ใช้ */
  function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, c => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
  }

  function itemImage(item, size = 'md') {
    if (item.photo_url) {
      return `<img src="${esc(item.photo_url)}" alt="${esc(item.name_th)}" loading="lazy"
        onerror="this.replaceWith(Object.assign(document.createElement('div'),
          {className:'item-img item-img--ph',textContent:'📦'}))">`;
    }
    return `<div class="item-img item-img--ph">📦</div>`;
  }

  /** ป้องกันหน้าที่ต้อง login — เรียกบนสุดของทุกหน้า */
  function requireLogin(adminOnly = false) {
    if (!API.isLoggedIn()) {
      location.href = CONFIG.BASE_PATH + 'login.html';
      return false;
    }
    if (adminOnly && !API.isAdmin()) {
      location.href = CONFIG.BASE_PATH + 'catalog.html';
      return false;
    }
    return true;
  }

  function renderHeader(active) {
    const user = API.getUser();
    const isAdmin = user?.role === 'ADMIN';
    const base = CONFIG.BASE_PATH;
    const cartCount = Cart.count();

    const links = isAdmin ? [
      ['admin/dashboard.html', 'แดชบอร์ด', 'dashboard'],
      ['admin/requests.html', 'คำขอยืม', 'requests'],
      ['admin/items.html', 'อุปกรณ์', 'items'],
      ['admin/students.html', 'นักเรียน', 'students']
    ] : [
      ['catalog.html', 'ยืมอุปกรณ์', 'catalog'],
      ['my-loans.html', 'รายการของฉัน', 'loans']
    ];

    return `
      <header class="app-header">
        <div class="app-header__inner">
          <a class="app-header__brand" href="${base}${isAdmin ? 'admin/dashboard.html' : 'catalog.html'}">
            <span class="app-header__logo">🔧</span>
            <span>E-Borrow</span>
          </a>
          <nav class="app-header__nav">
            ${links.map(([href, label, key]) => `
              <a href="${base}${href}" class="${active === key ? 'is-active' : ''}">${label}</a>
            `).join('')}
          </nav>
          <div class="app-header__right">
            ${!isAdmin ? `
              <a href="${base}cart.html" class="cart-link ${active === 'cart' ? 'is-active' : ''}">
                🛒${cartCount ? `<span class="cart-badge">${cartCount}</span>` : ''}
              </a>` : ''}
            <button class="btn-logout" onclick="UI.logout()" title="ออกจากระบบ">
              <span class="user-name">${esc(user?.full_name || '')}</span> ⏻
            </button>
          </div>
        </div>
      </header>`;
  }

  async function logout() {
    if (!await confirmDialog('ต้องการออกจากระบบใช่ไหม?', 'ออกจากระบบ')) return;
    try { await API.write('logout', {}, { noRedirect: true }); } catch { /* ออกได้อยู่ดี */ }
    API.clearSession();
    try { localStorage.removeItem(CONFIG.CART_KEY); } catch {}
    location.href = CONFIG.BASE_PATH + 'login.html';
  }

  function empty(message, icon = '📭') {
    return `<div class="empty-state"><div class="empty-state__icon">${icon}</div>
      <p>${esc(message)}</p></div>`;
  }

  return {
    toast, error, success, apiError, loading, withButton, confirmDialog,
    formatDate, relativeDue, statusBadge, esc, itemImage,
    requireLogin, renderHeader, logout, empty, STATUS_LABELS
  };
})();
