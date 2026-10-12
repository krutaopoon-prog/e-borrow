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

  /**
   * ไอคอนเส้น (จากชุด Lucide, ISC license) — แทนอิโมจิที่หน้าตาต่างกันในแต่ละเครื่อง
   * สีตาม currentColor ขนาดตาม font-size ของตัวที่ครอบ
   */
  const ICONS = {
    home: '<path d="m3 9 9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><path d="M9 22V12h6v10"/>',
    cart: '<circle cx="8" cy="21" r="1"/><circle cx="19" cy="21" r="1"/><path d="M2.05 2.05h2l2.66 12.42a2 2 0 0 0 2 1.58h9.78a2 2 0 0 0 1.95-1.57l1.65-7.43H5.12"/>',
    list: '<rect width="8" height="4" x="8" y="2" rx="1"/><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><path d="M12 11h4M12 16h4M8 11h.01M8 16h.01"/>',
    logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="m16 17 5-5-5-5M21 12H9"/>',
    search: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
    package: '<path d="M16.5 9.4 7.55 4.24"/><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><path d="M3.29 7 12 12l8.71-5M12 22V12"/>',
    camera: '<path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3z"/><circle cx="12" cy="13" r="3"/>',
    clock: '<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>',
    alert: '<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4M12 17h.01"/>',
    check: '<path d="M20 6 9 17l-5-5"/>',
    users: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/>',
    dashboard: '<rect width="7" height="9" x="3" y="3" rx="1"/><rect width="7" height="5" x="14" y="3" rx="1"/><rect width="7" height="9" x="14" y="12" rx="1"/><rect width="7" height="5" x="3" y="16" rx="1"/>',
    inbox: '<path d="M22 12h-6l-2 3h-4l-2-3H2"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/>',
    wrench: '<path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/>',
    printer: '<path d="M6 9V2h12v7"/><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><rect width="12" height="8" x="6" y="14"/>',
    refresh: '<path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/>',
    pin: '<path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z"/><circle cx="12" cy="10" r="3"/>',
    x: '<path d="M18 6 6 18M6 6l12 12"/>'
  };

  function icon(name, cls = '') {
    return `<svg class="icon ${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] || ''}</svg>`;
  }

  const PLACEHOLDER = `<div class="item-img item-img--ph">${icon('package')}</div>`;

  function itemImage(item) {
    if (item.photo_url) {
      return `<img src="${esc(item.photo_url)}" alt="${esc(item.name_th)}" loading="lazy"
        onerror="this.outerHTML=UI.PLACEHOLDER">`;
    }
    return PLACEHOLDER;
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

  const STUDENT_TABS = [
    ['catalog.html', 'ยืมอุปกรณ์', 'catalog', 'home'],
    ['cart.html', 'ตะกร้า', 'cart', 'cart'],
    ['my-loans.html', 'ของฉัน', 'loans', 'list']
  ];
  const ADMIN_TABS = [
    ['admin/dashboard.html', 'แดชบอร์ด', 'dashboard', 'dashboard'],
    ['admin/requests.html', 'คำขอยืม', 'requests', 'inbox'],
    ['admin/items.html', 'อุปกรณ์', 'items', 'package'],
    ['admin/students.html', 'นักเรียน', 'students', 'users']
  ];

  function cartBadge() {
    const n = Cart.count();
    return n ? `<span class="cart-badge">${n}</span>` : '';
  }

  function renderHeader(active) {
    const user = API.getUser();
    const isAdmin = user?.role === 'ADMIN';
    const base = CONFIG.BASE_PATH;
    // หัวเว็บบนจอใหญ่ไม่ซ้ำตะกร้าในเมนู เพราะมีไอคอนตะกร้าทางขวาอยู่แล้ว
    const links = isAdmin ? ADMIN_TABS : STUDENT_TABS.filter(t => t[2] !== 'cart');

    return `
      <header class="app-header">
        <div class="app-header__inner">
          <a class="app-header__brand" href="${base}${isAdmin ? 'admin/dashboard.html' : 'catalog.html'}">
            ${icon('wrench', 'app-header__logo')}
            <span>E-Borrow</span>
          </a>
          <nav class="app-header__nav">
            ${links.map(([href, label, key]) => `
              <a href="${base}${href}" class="${active === key ? 'is-active' : ''}">${label}</a>
            `).join('')}
          </nav>
          <div class="app-header__right">
            ${!isAdmin ? `
              <a href="${base}cart.html" class="cart-link ${active === 'cart' ? 'is-active' : ''}"
                 aria-label="ตะกร้า">${icon('cart')}${cartBadge()}</a>` : ''}
            <button class="btn-logout" onclick="UI.logout()" title="ออกจากระบบ">
              <span class="user-name">${esc(user?.full_name || '')}</span>
              ${icon('logout')}<span class="btn-logout__label">ออก</span>
            </button>
          </div>
        </div>
      </header>`;
  }

  /** เมนูล่าง (มือถือ/แท็บเล็ต) — นักเรียน 3 แท็บ ครู 4 แท็บ */
  function renderBottomNav(active) {
    const base = CONFIG.BASE_PATH;
    const tabs = API.isAdmin() ? ADMIN_TABS : STUDENT_TABS;
    return `
      <nav class="bottom-nav">
        ${tabs.map(([href, label, key, ic]) => `
          <a href="${base}${href}" class="${active === key ? 'is-active' : ''}"
             ${active === key ? 'aria-current="page"' : ''}>
            <span class="bottom-nav__icon">${icon(ic)}${key === 'cart' ? cartBadge() : ''}</span>${label}
          </a>`).join('')}
      </nav>`;
  }

  async function logout() {
    if (!await confirmDialog('ต้องการออกจากระบบใช่ไหม?', 'ออกจากระบบ')) return;
    try { await API.write('logout', {}, { noRedirect: true }); } catch { /* ออกได้อยู่ดี */ }
    API.clearSession();
    try { localStorage.removeItem(CONFIG.CART_KEY); } catch {}
    location.href = CONFIG.BASE_PATH + 'login.html';
  }

  function empty(message, emoji = '📭') {
    return `<div class="empty-state"><div class="empty-state__icon">${emoji}</div>
      <p>${esc(message)}</p></div>`;
  }

  // ปุ่ม/ป้ายในหน้า HTML ที่ใส่ data-icon="ชื่อ" จะได้ไอคอนนำหน้าอัตโนมัติ
  // (ui.js โหลดท้าย body จึงหา element ได้ครบ)
  document.querySelectorAll('[data-icon]').forEach(el =>
    el.insertAdjacentHTML('afterbegin', icon(el.dataset.icon)));

  return {
    toast, error, success, apiError, loading, withButton, confirmDialog,
    formatDate, relativeDue, statusBadge, esc, itemImage, icon, PLACEHOLDER,
    requireLogin, renderHeader, renderBottomNav, logout, empty, STATUS_LABELS
  };
})();
