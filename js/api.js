/**
 * api.js — ตัวกลางเรียก Apps Script ตัวเดียวของทั้งเว็บ
 *
 * ============ อ่านก่อนแก้ไฟล์นี้ ============
 * Apps Script ตั้ง CORS header เองไม่ได้ (ContentService ไม่มี setHeaders)
 * และตอบ OPTIONS preflight ไม่ได้ ดังนั้น request ต้องเป็น "simple request"
 * ที่เบราว์เซอร์ไม่ยิง preflight เท่านั้น แปลว่า:
 *
 *   ห้าม  ใส่ header อะไรก็ตามนอกจาก Content-Type
 *   ห้าม  ใช้ Content-Type: application/json   (ทำให้เกิด preflight)
 *   ห้าม  ส่ง token ผ่าน header Authorization  (ทำให้เกิด preflight)
 *   ต้อง  ใช้ Content-Type: text/plain;charset=utf-8
 *   ต้อง  ส่ง token ไปใน body
 *   ต้อง  redirect: 'follow' เพราะ /exec ตอบ 302 ไป googleusercontent.com
 *
 * ถ้าแก้แล้วขึ้น CORS error ให้กลับมาอ่านย่อหน้านี้
 * ==========================================
 */

const API = (() => {
  const TOKEN_KEY = 'eborrow_token';
  const USER_KEY = 'eborrow_user';

  function getToken() {
    try { return localStorage.getItem(TOKEN_KEY) || ''; } catch { return ''; }
  }

  function setSession(token, user) {
    try {
      localStorage.setItem(TOKEN_KEY, token);
      localStorage.setItem(USER_KEY, JSON.stringify(user));
    } catch { /* โหมดส่วนตัวบางเบราว์เซอร์เขียนไม่ได้ */ }
  }

  function getUser() {
    try { return JSON.parse(localStorage.getItem(USER_KEY) || 'null'); } catch { return null; }
  }

  function clearSession() {
    try {
      localStorage.removeItem(TOKEN_KEY);
      localStorage.removeItem(USER_KEY);
    } catch { /* ignore */ }
  }

  function newRequestId() {
    if (crypto && crypto.randomUUID) return crypto.randomUUID();
    return 'r-' + Date.now() + '-' + Math.random().toString(36).slice(2);
  }

  /** ข้อผิดพลาดที่มีข้อความไทยพร้อมแสดงผล */
  class ApiError extends Error {
    constructor(code, messageTh, details) {
      super(messageTh || code);
      this.code = code;
      this.messageTh = messageTh || 'เกิดข้อผิดพลาด';
      this.details = details || null;
    }
  }

  const RETRYABLE = new Set(['SYSTEM_BUSY', 'NETWORK_ERROR']);

  /**
   * action ที่ backend บังคับให้มี requestId
   * เก็บไว้ที่นี่เพื่อให้ API.call() ธรรมดาก็ส่ง requestId ถูกต้อง
   * ไม่ต้องหวังให้ทุกจุดที่เรียกจำเอง
   */
  const WRITE_ACTIONS = new Set([
    'register', 'login', 'logout', 'changePin',
    'submitRequest', 'cancelRequest',
    'initiateReturn', 'uploadReturnPhoto', 'finalizeReturn',
    'adminApproveStudent', 'adminResetPin',
    'adminApproveRequest', 'adminRejectRequest',
    'adminIssueTransaction', 'adminConfirmReturn', 'adminMarkLost',
    'adminUpsertItem', 'adminUploadItemPhoto', 'adminAdjustStock',
    'adminUpsertCategory', 'adminSetConfig'
  ]);

  async function call(action, payload = {}, options = {}) {
    const isWrite = options.write === true || WRITE_ACTIONS.has(action);
    const requestId = options.requestId || newRequestId();
    const maxAttempts = options.retries ?? 3;

    let lastError = null;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      if (attempt > 0) {
        // backoff แบบมี jitter — 30 คนกดพร้อมกันตอนต้นคาบจะได้ไม่ชนกันซ้ำ
        const wait = Math.min(2000, 300 * 2 ** (attempt - 1)) + Math.random() * 200;
        await new Promise(r => setTimeout(r, wait));
      }

      let res;
      try {
        res = await fetch(CONFIG.API_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'text/plain;charset=utf-8' }, // ห้ามเปลี่ยน
          body: JSON.stringify({
            action,
            token: getToken(),
            payload,
            // requestId เดิมทุกครั้งที่ retry — ไม่งั้น retry จะกลายเป็นยืมซ้ำ
            requestId: isWrite ? requestId : undefined
          }),
          redirect: 'follow'
        });
      } catch (networkErr) {
        lastError = new ApiError('NETWORK_ERROR', 'เชื่อมต่อไม่ได้ ตรวจสอบอินเทอร์เน็ต');
        continue;
      }

      let body;
      try {
        body = await res.json();
      } catch {
        // ได้ HTML กลับมา = สคริปต์ throw ออกนอก try/catch หรือ URL ผิด
        lastError = new ApiError('INTERNAL_ERROR',
          'เซิร์ฟเวอร์ตอบกลับผิดรูปแบบ กรุณาแจ้งครู');
        continue;
      }

      if (body.ok) return body.data;

      const err = new ApiError(
        body.error?.code || 'INTERNAL_ERROR',
        body.error?.message_th,
        body.error?.details
      );

      if (err.code === 'SESSION_EXPIRED' || err.code === 'UNAUTHENTICATED') {
        clearSession();
        if (!options.noRedirect) {
          window.location.href = CONFIG.BASE_PATH + 'login.html';
        }
        throw err;
      }

      if (!RETRYABLE.has(err.code)) throw err;
      lastError = err;
    }

    throw lastError;
  }

  const read = (action, payload, options) => call(action, payload, { ...options, write: false });
  const write = (action, payload, options) => call(action, payload, { ...options, write: true });

  return {
    call, read, write, ApiError,
    getToken, setSession, getUser, clearSession, newRequestId,
    isLoggedIn: () => !!getToken(),
    isAdmin: () => getUser()?.role === 'ADMIN'
  };
})();
