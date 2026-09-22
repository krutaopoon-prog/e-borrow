/**
 * Main.gs — doPost dispatcher เดียวของทั้งระบบ
 *
 * ================== ข้อจำกัดที่ห้ามละเมิด ==================
 * 1. ContentService ไม่มี setHeaders() → ตั้ง CORS header เองไม่ได้
 *    ทางเดียวที่ client เรียกข้าม origin ได้คือส่งเป็น "simple request"
 *    (Content-Type: text/plain) ที่ไม่เกิด preflight — ดู web/js/api.js
 * 2. ต้องตอบ HTTP 200 เสมอ แม้ error — ถ้า throw ออกไป Apps Script
 *    จะคืนหน้า HTML ที่ client parse ไม่ได้ และแยกไม่ออกจาก network error
 * 3. อย่าย้าย logic ออกจาก doPost ไป doGet — มีทางเข้าเดียวจึงป้องกันได้
 * ==========================================================
 */

var APP_VERSION = '1.0.0';

/** ทุก action ที่ขึ้นต้นด้วย admin จะถูกบังคับตรวจสิทธิ์อัตโนมัติ */
var PUBLIC_ACTIONS = {
  ping: true,
  getPublicConfig: true,
  register: true,
  login: true,
  getCatalog: true,
  listItems: true,
  getItem: true
};

/**
 * action ที่เปลี่ยนแปลงข้อมูล — ต้องมี requestId เพื่อกันส่งซ้ำ
 * รวมงานของครูด้วย เพราะการกดซ้ำตอนสัญญาณไม่ดีจะทำให้
 * เช่น adminAdjustStock เพิ่มตัวต้านทาน 100 ตัวเป็นสองรอบ
 */
var WRITE_ACTIONS = {
  register: true, login: true, logout: true, changePin: true,
  submitRequest: true, cancelRequest: true,
  initiateReturn: true, uploadReturnPhoto: true, finalizeReturn: true,
  adminApproveStudent: true, adminResetPin: true,
  adminApproveRequest: true, adminRejectRequest: true,
  adminIssueTransaction: true, adminConfirmReturn: true, adminMarkLost: true,
  adminUpsertItem: true, adminUploadItemPhoto: true, adminAdjustStock: true,
  adminUpsertCategory: true, adminSetConfig: true
};

var HANDLERS = {
  // ระบบ
  ping: handlePing_,
  getPublicConfig: handleGetPublicConfig_,

  // Auth
  register: handleRegister_,
  login: handleLogin_,
  validateSession: handleValidateSession_,
  logout: handleLogout_,
  changePin: handleChangePin_,

  // แคตตาล็อก
  getCatalog: handleGetCatalog_,
  listItems: handleListItems_,
  getItem: handleGetItem_,

  // ยืม
  validateCart: handleValidateCart_,
  submitRequest: handleSubmitRequest_,
  cancelRequest: handleCancelRequest_,
  myTransactions: handleMyTransactions_,
  getTransaction: handleGetTransaction_,

  // คืน
  initiateReturn: handleInitiateReturn_,
  uploadReturnPhoto: handleUploadReturnPhoto_,
  finalizeReturn: handleFinalizeReturn_,

  // ครู
  adminPendingStudents: handleAdminPendingStudents_,
  adminApproveStudent: handleAdminApproveStudent_,
  adminListStudents: handleAdminListStudents_,
  adminResetPin: handleAdminResetPin_,
  adminPendingRequests: handleAdminPendingRequests_,
  adminApproveRequest: handleAdminApproveRequest_,
  adminRejectRequest: handleAdminRejectRequest_,
  adminIssueTransaction: handleAdminIssueTransaction_,
  adminConfirmReturn: handleAdminConfirmReturn_,
  adminMarkLost: handleAdminMarkLost_,
  adminDashboard: handleAdminDashboard_,
  adminUpsertItem: handleAdminUpsertItem_,
  adminUploadItemPhoto: handleAdminUploadItemPhoto_,
  adminAdjustStock: handleAdminAdjustStock_,
  adminUpsertCategory: handleAdminUpsertCategory_,
  adminGetConfig: handleAdminGetConfig_,
  adminSetConfig: handleAdminSetConfig_,
  adminReconcile: handleAdminReconcile_
};

function doPost(e) {
  var req = null;
  try {
    if (!e || !e.postData || !e.postData.contents) {
      throw new AppError('BAD_REQUEST', 'ไม่พบข้อมูลที่ส่งมา');
    }
    req = JSON.parse(e.postData.contents);
  } catch (err) {
    return jsonOut_(errorEnvelope_('BAD_REQUEST', 'รูปแบบข้อมูลไม่ถูกต้อง'));
  }

  var action = asString(req.action);
  var token = asString(req.token);
  var payload = req.payload || {};
  var requestId = asString(req.requestId);

  try {
    var handler = HANDLERS[action];
    if (!handler) {
      throw new AppError('BAD_REQUEST', 'ไม่รู้จักคำสั่ง: ' + action);
    }

    // กันส่งซ้ำ — มือถือบนไวไฟวิทยาลัยจะกดซ้ำ/ส่งซ้ำแน่นอน
    // คืนคำตอบเดิมแทนที่จะสร้างรายการยืมใบที่สอง
    if (WRITE_ACTIONS[action]) {
      if (!requestId) {
        throw new AppError('BAD_REQUEST', 'ขาด requestId');
      }
      var cached = getIdempotentResponse_(requestId);
      if (cached) return jsonOut_(cached);
    }

    // ชั้นป้องกันที่ 2: บังคับตามชื่อ action เผื่อ handler ลืมเช็กเอง
    var session = null;
    if (action.indexOf('admin') === 0) {
      session = requireAdmin_(token);
    } else if (!PUBLIC_ACTIONS[action]) {
      session = requireAuth_(token);
    }

    var data = handler(payload, session, requestId);
    var envelope = { ok: true, data: data, serverTime: nowIso() };

    if (WRITE_ACTIONS[action] && requestId) {
      saveIdempotentResponse_(requestId, envelope);
    }
    if (session) {
      auditLog_(session.student_id, session.role, action, 'OK', payload);
    }
    return jsonOut_(envelope);

  } catch (err) {
    var code = (err && err.code) ? err.code : 'INTERNAL_ERROR';
    var msg = (err && err.messageTh) ? err.messageTh : ERROR_MESSAGES_TH.INTERNAL_ERROR;

    // บันทึกทุกครั้งที่ถูกปฏิเสธ — นี่คือสิ่งที่บอกว่ามีคนพยายามเดา PIN
    try {
      var result = (code === 'FORBIDDEN' || code === 'UNAUTHENTICATED' ||
                    code === 'INVALID_CREDENTIALS') ? 'DENIED' : 'ERROR';
      auditLog_('', '', action, result, { code: code, detail: String(err) });
    } catch (logErr) { /* log ล้มเหลวต้องไม่ทำให้ response พัง */ }

    if (code === 'INTERNAL_ERROR') {
      console.error('Unhandled in ' + action + ': ' + (err && err.stack ? err.stack : err));
    }
    return jsonOut_(errorEnvelope_(code, msg, err && err.details));
  }
}

/**
 * doGet มีไว้ตรวจสุขภาพและให้เปิด URL ทดสอบในเบราว์เซอร์ได้เท่านั้น
 * ห้ามใส่ business logic ตรงนี้
 */
function doGet(e) {
  return jsonOut_({
    ok: true,
    data: { service: 'E-Borrow API', version: APP_VERSION, method: 'ใช้ POST สำหรับทุกคำสั่ง' },
    serverTime: nowIso()
  });
}

function jsonOut_(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function errorEnvelope_(code, messageTh, details) {
  return {
    ok: false,
    error: { code: code, message_th: messageTh, details: details || null },
    serverTime: nowIso()
  };
}

function handlePing_(payload, session) {
  return { pong: true, version: APP_VERSION, timeZone: TZ };
}

function handleGetPublicConfig_(payload, session) {
  return {
    app_name: getConfig_('app_name', 'E-Borrow'),
    levels: getConfigJson_('levels_json', []),
    departments: getConfigJson_('departments_json', []),
    announcement: getConfig_('announcement', ''),
    require_photo_on_return: getConfigBool_('require_photo_on_return', true)
  };
}

// ---- idempotency ----

function getIdempotentResponse_(requestId) {
  var cache = CacheService.getScriptCache();
  var hit = cache.get('idem_' + requestId);
  return hit ? JSON.parse(hit) : null;
}

function saveIdempotentResponse_(requestId, envelope) {
  try {
    CacheService.getScriptCache().put('idem_' + requestId, JSON.stringify(envelope), 600);
  } catch (err) {
    // payload ใหญ่เกิน cache — ไม่เป็นไร แค่เสียคุณสมบัติกันส่งซ้ำของรายการนี้
    console.warn('idempotency cache skipped: ' + err);
  }
}
