/**
 * api.js — ตัวกลางเรียกหลังบ้าน (Supabase) ตัวเดียวของทั้งเว็บ
 *
 * ทุกคำสั่งวิ่งไปที่ฟังก์ชันเดียวในฐานข้อมูล: POST /rest/v1/rpc/api
 * ซึ่งตรวจ token และสิทธิ์ก่อนทุกครั้ง (ดู supabase/migrations/008_api.sql)
 * หน้าเว็บอ่าน/เขียนตารางตรงๆ ไม่ได้ — ทุกตารางปิดด้วย RLS
 *
 * คำตอบเป็น envelope เดิม: {ok, data} หรือ {ok:false, error:{code, message_th}}
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

  /** header ที่ Supabase ต้องการ — key แบบใหม่ (sb_publishable_...) ไม่ใช่ JWT ห้ามใส่ใน Authorization */
  function supabaseHeaders(extra) {
    const key = CONFIG.SUPABASE_ANON_KEY;
    const h = { apikey: key, ...extra };
    if (key.startsWith('eyJ')) h.Authorization = 'Bearer ' + key;
    return h;
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
    'initiateReturn', 'finalizeReturn',
    'adminApproveStudent', 'adminResetPin',
    'adminApproveRequest', 'adminRejectRequest',
    'adminIssueTransaction', 'adminConfirmReturn', 'adminMarkLost',
    'adminUpsertItem', 'adminCreateItemUploadTicket', 'adminUploadItemPhoto',
    'adminAdjustStock', 'adminUpsertCategory', 'adminSetConfig'
  ]);

  function backoff(attempt) {
    // มี jitter — 30 คนกดพร้อมกันตอนต้นคาบจะได้ไม่ชนกันซ้ำ
    const wait = Math.min(2000, 300 * 2 ** (attempt - 1)) + Math.random() * 200;
    return new Promise(r => setTimeout(r, wait));
  }

  async function call(action, payload = {}, options = {}) {
    const isWrite = options.write === true || WRITE_ACTIONS.has(action);
    const requestId = options.requestId || newRequestId();
    const maxAttempts = options.retries ?? 3;

    let lastError = null;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      if (attempt > 0) await backoff(attempt);

      let res;
      try {
        res = await fetch(CONFIG.SUPABASE_URL + '/rest/v1/rpc/api', {
          method: 'POST',
          headers: supabaseHeaders({ 'Content-Type': 'application/json' }),
          body: JSON.stringify({
            action,
            token: getToken() || null,
            payload,
            // requestId เดิมทุกครั้งที่ retry — ไม่งั้น retry จะกลายเป็นยืมซ้ำ
            request_id: isWrite ? requestId : null
          })
        });
      } catch (networkErr) {
        lastError = new ApiError('NETWORK_ERROR', 'เชื่อมต่อไม่ได้ ตรวจสอบอินเทอร์เน็ต');
        continue;
      }

      // 5xx / 429 = ฐานข้อมูลยุ่งหรือกำลังตื่นจากการพักโปรเจกต์ — ลองใหม่ได้
      if (res.status >= 500 || res.status === 429) {
        lastError = new ApiError('SYSTEM_BUSY', 'ระบบกำลังยุ่ง กรุณาลองใหม่อีกครั้ง');
        continue;
      }

      let body;
      try {
        body = await res.json();
      } catch {
        lastError = new ApiError('INTERNAL_ERROR', 'เซิร์ฟเวอร์ตอบกลับผิดรูปแบบ กรุณาแจ้งครู');
        continue;
      }

      // ไม่ใช่ envelope ของเรา = ตั้งค่า URL/key ผิด หรือยังไม่ได้รัน SQL
      if (!res.ok || typeof body?.ok !== 'boolean') {
        console.error('[E-Borrow] Supabase error', res.status, body);
        throw new ApiError('INTERNAL_ERROR', 'เชื่อมต่อฐานข้อมูลไม่ได้ กรุณาแจ้งครู');
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

  /**
   * อัปรูปตรงไป Supabase Storage (ไม่ผ่านฐานข้อมูล)
   * ticket ได้จาก api() — Storage ยอมรับเฉพาะ path ที่ขึ้นต้นด้วยตั๋วที่ยังไม่หมดอายุ
   */
  async function uploadPhoto(bucket, ticket, blob, filename) {
    const ext = blob.type === 'image/webp' ? 'webp' : 'jpg';
    const url = `${CONFIG.SUPABASE_URL}/storage/v1/object/${bucket}/${ticket}/${filename}.${ext}`;
    let lastError = null;

    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt > 0) await backoff(attempt);
      let res;
      try {
        res = await fetch(url, {
          method: 'POST',
          headers: supabaseHeaders({ 'Content-Type': blob.type, 'x-upsert': 'false' }),
          body: blob
        });
      } catch {
        lastError = new ApiError('NETWORK_ERROR', 'อัปโหลดรูปไม่สำเร็จ ตรวจสอบอินเทอร์เน็ต');
        continue;
      }
      // 409 = รอบก่อนอัปสำเร็จแล้วแต่คำตอบหายระหว่างทาง ถือว่าสำเร็จ
      if (res.ok || res.status === 409) return;

      const text = await res.text().catch(() => '');
      if (res.status === 413 || /maximum allowed size|too large/i.test(text)) {
        throw new ApiError('PHOTO_TOO_LARGE', 'รูปมีขนาดใหญ่เกินไป กรุณาถ่ายใหม่');
      }
      if (res.status >= 500) {
        lastError = new ApiError('SYSTEM_BUSY', 'ระบบกำลังยุ่ง กรุณาลองใหม่อีกครั้ง');
        continue;
      }
      console.error('[E-Borrow] upload failed', res.status, text);
      throw new ApiError('INTERNAL_ERROR', 'อัปโหลดรูปไม่สำเร็จ กรุณาเริ่มใหม่');
    }
    throw lastError;
  }

  const read = (action, payload, options) => call(action, payload, { ...options, write: false });
  const write = (action, payload, options) => call(action, payload, { ...options, write: true });

  return {
    call, read, write, uploadPhoto, ApiError,
    getToken, setSession, getUser, clearSession, newRequestId,
    isLoggedIn: () => !!getToken(),
    isAdmin: () => getUser()?.role === 'ADMIN'
  };
})();
