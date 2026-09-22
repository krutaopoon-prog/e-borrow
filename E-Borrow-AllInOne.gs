/**
 * ============================================================
 *  E-Borrow — ระบบยืม-คืนอุปกรณ์ห้องเรียน (ไฟล์รวม)
 *  วิทยาลัยเทคนิคอุตรดิตถ์
 * ============================================================
 *
 *  ไฟล์นี้รวมโค้ดทั้งหมดไว้ที่เดียว ก๊อปวางครั้งเดียวจบ
 *
 *  วิธีใช้:
 *   1. เปิด Google Sheets ใหม่ → ส่วนขยาย → Apps Script
 *   2. ลบโค้ดเดิมใน Code.gs ทิ้งทั้งหมด
 *   3. ก๊อปไฟล์นี้ทั้งไฟล์วางแทน แล้วกดบันทึก (Ctrl+S)
 *   4. เลือกฟังก์ชัน setupSpreadsheet จาก dropdown ด้านบน → กด Run
 *   5. แก้ ADMIN_ID / ADMIN_NAME / ADMIN_PIN ในฟังก์ชัน createAdminAccount
 *      (อยู่ประมาณกลางไฟล์ กด Ctrl+F หาคำว่า createAdminAccount)
 *   6. เลือก createAdminAccount → Run
 *   7. เลือก installTriggers → Run
 *   8. Deploy → New deployment → Web app
 *        Execute as     : Me
 *        Who has access : Anyone     ← ต้องเป็น Anyone เฉยๆ
 *
 *  ⚠️ เวลาแก้โค้ดทีหลัง ต้อง Deploy → Manage deployments → ✏️ → New version
 *     ห้ามกด "New deployment" เพราะ URL จะเปลี่ยนและเว็บจะพัง
 *
 * ============================================================
 */


// ████████████████████████████████████████████████████████████
// ███  แก้ 3 บรรทัดนี้ก่อนใช้งาน — มีแค่ตรงนี้ที่ต้องแก้  ███
// ████████████████████████████████████████████████████████████

var SETUP = {

  ADMIN_ID:   '000000',            // ← รหัสที่ครูใช้เข้าระบบ (ตัวเลขล้วน)

  ADMIN_NAME: 'ครูผู้ดูแลระบบ',     // ← ชื่อ-สกุลของครู

  ADMIN_PIN:  ''                   // ← ใส่ PIN ของครู 6-8 หลัก ตอนติดตั้งเท่านั้น
                                   //   ติดตั้งเสร็จแล้วลบออกให้เป็น '' เหมือนเดิม
                                   //   (ไฟล์นี้อยู่บน GitHub แบบสาธารณะ)
};

// ████████████████████████████████████████████████████████████
// ███  ข้างล่างนี้ไม่ต้องแก้อะไรแล้ว เลื่อนผ่านได้เลย      ███
// ████████████████████████████████████████████████████████████


// ============================================================
// ===== ส่วนที่มาจากไฟล์ Util.gs
// ============================================================

/**
 * Util.gs — ID generation, date handling, errors, crypto helpers.
 *
 * ทุกเวลาในระบบเก็บเป็น ISO 8601 + offset ไทย แบบ "ข้อความ" เสมอ
 * ห้ามปล่อยให้ Sheets แปลงเป็น date object (locale coercion ทำให้เพี้ยน)
 */

var TZ = 'Asia/Bangkok';

/** ข้อผิดพลาดที่ตั้งใจให้ผู้ใช้เห็น พร้อมข้อความไทย */
function AppError(code, messageTh, details) {
  this.name = 'AppError';
  this.code = code;
  this.messageTh = messageTh || ERROR_MESSAGES_TH[code] || 'เกิดข้อผิดพลาด';
  this.details = details || null;
  this.stack = new Error().stack;
}
AppError.prototype = Object.create(Error.prototype);
AppError.prototype.constructor = AppError;

var ERROR_MESSAGES_TH = {
  BAD_REQUEST: 'คำขอไม่ถูกต้อง',
  UNAUTHENTICATED: 'กรุณาเข้าสู่ระบบก่อน',
  SESSION_EXPIRED: 'เซสชันหมดอายุ กรุณาเข้าสู่ระบบใหม่',
  FORBIDDEN: 'คุณไม่มีสิทธิ์ใช้งานส่วนนี้',
  ACCOUNT_PENDING: 'บัญชีของคุณรอครูอนุมัติ',
  ACCOUNT_SUSPENDED: 'บัญชีของคุณถูกระงับ กรุณาติดต่อครู',
  ACCOUNT_LOCKED: 'ใส่รหัสผิดหลายครั้ง บัญชีถูกล็อกชั่วคราว',
  INVALID_CREDENTIALS: 'รหัสนักศึกษาหรือ PIN ไม่ถูกต้อง',
  DUPLICATE_STUDENT_ID: 'รหัสนักศึกษานี้ลงทะเบียนแล้ว',
  WEAK_PIN: 'PIN นี้เดาง่ายเกินไป กรุณาตั้งใหม่',
  NOT_FOUND: 'ไม่พบข้อมูลที่ต้องการ',
  INVALID_STATE: 'ไม่สามารถทำรายการนี้ได้ในสถานะปัจจุบัน',
  INSUFFICIENT_STOCK: 'อุปกรณ์ไม่เพียงพอ',
  LIMIT_EXCEEDED: 'เกินจำนวนที่ยืมได้',
  HAS_OVERDUE: 'คุณมีอุปกรณ์เกินกำหนดคืน กรุณาคืนก่อนยืมใหม่',
  PHOTO_REQUIRED: 'กรุณาถ่ายรูปอุปกรณ์ตอนคืน',
  PHOTO_TOO_LARGE: 'รูปมีขนาดใหญ่เกินไป',
  SYSTEM_BUSY: 'ระบบกำลังยุ่ง กรุณาลองใหม่อีกครั้ง',
  INTERNAL_ERROR: 'เกิดข้อผิดพลาดในระบบ กรุณาแจ้งครู'
};

/** เวลาปัจจุบันแบบ ISO 8601 + offset ไทย เช่น 2026-09-22T14:30:00+07:00 */
function nowIso() {
  return Utilities.formatDate(new Date(), TZ, "yyyy-MM-dd'T'HH:mm:ssXXX");
}

function toIso(date) {
  return Utilities.formatDate(date, TZ, "yyyy-MM-dd'T'HH:mm:ssXXX");
}

function parseIso(s) {
  if (!s) return null;
  var d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
}

/** บวกวันแล้วคืนเป็น ISO string. days = 0 หมายถึงสิ้นวันนี้ (จบคาบเรียน) */
function addDaysIso(days) {
  var d = new Date();
  if (days === 0) {
    d.setHours(23, 59, 59, 0);
  } else {
    d.setDate(d.getDate() + Number(days));
  }
  return toIso(d);
}

function isPast(isoString) {
  var d = parseIso(isoString);
  return d ? d.getTime() < Date.now() : false;
}

/** YYYYMMDD ตามเวลาไทย ใช้เป็น prefix ของ txn_id */
function dateStamp() {
  return Utilities.formatDate(new Date(), TZ, 'yyyyMMdd');
}

function yearMonth() {
  return Utilities.formatDate(new Date(), TZ, 'yyyy-MM');
}

function uuid() {
  return Utilities.getUuid();
}

/** Token 32 bytes — ต่อ uuid สองอันแล้ว hash เพื่อไม่ให้เดาได้ */
function randomToken() {
  var raw = Utilities.getUuid() + Utilities.getUuid() + Date.now();
  return toHex_(Utilities.computeDigest(
    Utilities.DigestAlgorithm.SHA_256, raw, Utilities.Charset.UTF_8));
}

function randomSalt() {
  return toHex_(Utilities.computeDigest(
    Utilities.DigestAlgorithm.MD5,
    Utilities.getUuid() + Date.now(),
    Utilities.Charset.UTF_8));
}

function toHex_(byteArray) {
  var out = '';
  for (var i = 0; i < byteArray.length; i++) {
    var b = byteArray[i] & 0xFF;
    out += (b < 16 ? '0' : '') + b.toString(16);
  }
  return out;
}

/**
 * เทียบสตริงแบบ constant-time — ป้องกัน timing attack ตอนเทียบ hash
 * ห้ามใช้ === กับ pin_hash
 */
function safeEquals(a, b) {
  a = String(a || '');
  b = String(b || '');
  if (a.length !== b.length) return false;
  var diff = 0;
  for (var i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

/** อ่านค่าจาก Sheets ให้เป็น string เสมอ — กันเลข 0 นำหน้ารหัสนักศึกษาหาย */
function asString(v) {
  if (v === null || v === undefined) return '';
  return String(v).trim();
}

function asNumber(v) {
  if (v === null || v === undefined || v === '') return 0;
  var n = Number(v);
  return isNaN(n) ? 0 : n;
}

function asBool(v) {
  if (v === true) return true;
  if (v === false || v === null || v === undefined || v === '') return false;
  var s = String(v).trim().toLowerCase();
  return s === 'true' || s === 'yes' || s === '1' || s === 'ใช่';
}

// ============================================================
// ===== ส่วนที่มาจากไฟล์ Sheets.gs
// ============================================================

/**
 * Sheets.gs — อ่าน/เขียน Google Sheets แบบ map จาก header
 *
 * หลักการ:
 * - อ้างอิงคอลัมน์ด้วย "ชื่อ header" เสมอ ไม่ใช่เลขคอลัมน์
 *   ครูสลับคอลัมน์ในชีตแล้วระบบต้องไม่พัง
 * - อ่าน/เขียนเป็นก้อน (getValues/setValues ครั้งเดียว)
 *   ห้ามวนอ่านทีละเซลล์ — จะชนขีดจำกัด 6 นาทีตั้งแต่ข้อมูลยังน้อย
 * - appendRow() เป็น atomic ใช้กับ log ได้โดยไม่ต้องล็อก
 */

var SHEETS = {
  STUDENTS: 'Students',
  ITEMS: 'Items',
  CATEGORIES: 'Categories',
  TRANSACTIONS: 'Transactions',
  LINES: 'TransactionLines',
  LEDGER: 'StockLedger',
  SESSIONS: 'Sessions',
  CONFIG: 'Config',
  AUDIT: 'AuditLog'
};

var SCHEMA = {
  Students: ['student_id', 'full_name', 'level', 'department', 'section', 'phone',
    'pin_hash', 'pin_salt', 'status', 'role', 'registered_at', 'approved_at',
    'approved_by', 'failed_pin_count', 'locked_until', 'active_loan_count',
    'overdue_count', 'notes'],

  Items: ['item_id', 'name_th', 'name_en', 'category_id', 'description',
    'photo_file_id', 'photo_url', 'is_consumable', 'unit', 'total_qty',
    'available_qty', 'reserved_qty', 'out_qty', 'min_qty', 'max_per_borrow',
    'default_due_days', 'storage_location', 'status', 'tags',
    'created_at', 'updated_at'],

  Categories: ['category_id', 'name_th', 'name_en', 'icon', 'sort_order',
    'parent_id', 'status'],

  Transactions: ['txn_id', 'student_id', 'student_name_snapshot', 'status',
    'requested_at', 'approved_at', 'issued_at', 'due_at', 'returned_at',
    'cancelled_at', 'handled_by', 'line_count', 'total_qty', 'outstanding_qty',
    'purpose', 'return_photo_file_id', 'return_photo_url', 'return_note',
    'condition_on_return', 'created_at', 'updated_at'],

  TransactionLines: ['line_id', 'txn_id', 'item_id', 'item_name_snapshot',
    'is_consumable_snapshot', 'unit_snapshot', 'qty_requested', 'qty_approved',
    'qty_issued', 'qty_returned', 'qty_lost', 'line_due_at', 'line_status',
    'storage_location_snapshot', 'note'],

  StockLedger: ['ledger_id', 'timestamp', 'item_id', 'txn_id', 'line_id',
    'event_type', 'delta_available', 'delta_reserved', 'delta_out',
    'delta_total', 'available_after', 'actor_id', 'reason'],

  Sessions: ['token', 'student_id', 'role', 'issued_at', 'expires_at',
    'last_seen_at', 'user_agent', 'revoked'],

  Config: ['key', 'value', 'type', 'description_th'],

  AuditLog: ['log_id', 'timestamp', 'actor_id', 'actor_role', 'action',
    'target_type', 'target_id', 'detail_json', 'result']
};

/** คอลัมน์ที่ต้องบังคับเป็นข้อความ ไม่งั้นเลข 0 นำหน้าหาย */
var TEXT_COLUMNS = {
  Students: ['student_id', 'phone'],
  Transactions: ['student_id'],
  Sessions: ['student_id']
};

/**
 * จำไว้ในหน่วยความจำตลอดการทำงาน 1 ครั้ง (ไม่ข้าม request)
 *
 * ทำไมสำคัญมาก: การเปิดสเปรดชีตและหาแท็บเป็นงานที่ช้าที่สุดใน Apps Script
 * ระบบเรียก readAll_ หลายสิบรอบต่อ 1 คำขอ ถ้าเปิดใหม่ทุกครั้ง
 * getCatalog จะใช้เวลา 30+ วินาที แทนที่จะเป็น 2 วินาที
 */
var _ssCache = null;
var _sheetCache = {};
var _rowsCache = {};

function ss_() {
  if (_ssCache) return _ssCache;
  var id = PropertiesService.getScriptProperties().getProperty('SPREADSHEET_ID');
  _ssCache = id ? SpreadsheetApp.openById(id) : SpreadsheetApp.getActiveSpreadsheet();
  return _ssCache;
}

function sheet_(name) {
  if (_sheetCache[name]) return _sheetCache[name];
  var sh = ss_().getSheetByName(name);
  if (!sh) throw new AppError('INTERNAL_ERROR', 'ไม่พบชีต: ' + name);
  _sheetCache[name] = sh;
  return sh;
}

/** ล้างข้อมูลแถวที่จำไว้ — ต้องเรียกหลังเขียนชีต ไม่งั้นอ่านได้ค่าเก่า */
function invalidateRows_(sheetName) {
  if (sheetName) delete _rowsCache[sheetName];
  else _rowsCache = {};
}

/**
 * อ่านทั้งแท็บเป็น array ของ object
 * ใช้ getDisplayValues เพื่อให้ได้ string เสมอ — กันเลข 0 นำหน้าหาย
 * และกัน Sheets แปลง ISO string เป็น Date object
 */
function readAll_(sheetName) {
  // จำผลไว้ภายในคำขอเดียวกัน — findRow_/findRows_ เรียกซ้ำหลายรอบ
  // ต้องล้างด้วย invalidateRows_ ทุกครั้งที่เขียน ไม่งั้นอ่านค่าเก่า
  if (_rowsCache[sheetName]) return _rowsCache[sheetName];

  var sh = sheet_(sheetName);
  var lastRow = sh.getLastRow();
  if (lastRow < 2) { _rowsCache[sheetName] = []; return []; }

  var values = sh.getRange(1, 1, lastRow, sh.getLastColumn()).getDisplayValues();
  var headers = values[0];
  var rows = [];

  for (var r = 1; r < values.length; r++) {
    var obj = { _row: r + 1 };
    var empty = true;
    for (var c = 0; c < headers.length; c++) {
      var key = headers[c];
      if (!key) continue;
      obj[key] = values[r][c];
      if (values[r][c] !== '') empty = false;
    }
    if (!empty) rows.push(obj);
  }
  _rowsCache[sheetName] = rows;
  return rows;
}

/** หาแถวเดียวด้วยค่าในคอลัมน์ — คืน null ถ้าไม่เจอ */
function findRow_(sheetName, column, value) {
  var target = asString(value);
  if (!target) return null;
  var rows = readAll_(sheetName);
  for (var i = 0; i < rows.length; i++) {
    if (asString(rows[i][column]) === target) return rows[i];
  }
  return null;
}

function findRows_(sheetName, column, value) {
  var target = asString(value);
  return readAll_(sheetName).filter(function (r) {
    return asString(r[column]) === target;
  });
}

/** เพิ่มแถวใหม่ — atomic ไม่ต้องล็อก */
function appendRow_(sheetName, obj) {
  var sh = sheet_(sheetName);
  var headers = SCHEMA[sheetName];
  var row = headers.map(function (h) {
    var v = obj[h];
    if (v === null || v === undefined) return '';
    if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
    return v;
  });
  sh.appendRow(row);
  invalidateRows_(sheetName);   // เขียนแล้วต้องล้าง ไม่งั้นอ่านได้ค่าเก่า
  return obj;
}

/**
 * แก้ไขแถวที่มีอยู่ ด้วยเลขแถวจริง (_row)
 * ผู้เรียกต้องถือ lock อยู่แล้วถ้าเป็นการ read-modify-write
 */
function updateRow_(sheetName, rowNumber, patch) {
  var sh = sheet_(sheetName);
  var headers = SCHEMA[sheetName];
  var current = sh.getRange(rowNumber, 1, 1, headers.length).getDisplayValues()[0];

  for (var i = 0; i < headers.length; i++) {
    var key = headers[i];
    if (patch.hasOwnProperty(key)) {
      var v = patch[key];
      if (v === null || v === undefined) v = '';
      else if (typeof v === 'boolean') v = v ? 'TRUE' : 'FALSE';
      current[i] = v;
    }
  }
  sh.getRange(rowNumber, 1, 1, headers.length).setValues([current]);
  invalidateRows_(sheetName);
}

/** เขียนหลายแถวพร้อมกัน — ใช้ตอนตัดสต็อกหลายรายการในล็อกเดียว */
function updateRowsBatch_(sheetName, updates) {
  if (!updates.length) return;
  var sh = sheet_(sheetName);
  var headers = SCHEMA[sheetName];

  updates.forEach(function (u) {
    var current = sh.getRange(u.row, 1, 1, headers.length).getDisplayValues()[0];
    for (var i = 0; i < headers.length; i++) {
      var key = headers[i];
      if (u.patch.hasOwnProperty(key)) {
        var v = u.patch[key];
        if (v === null || v === undefined) v = '';
        else if (typeof v === 'boolean') v = v ? 'TRUE' : 'FALSE';
        current[i] = v;
      }
    }
    sh.getRange(u.row, 1, 1, headers.length).setValues([current]);
  });
  invalidateRows_(sheetName);
}

// ---- สร้างชีตครั้งแรก ----

/**
 * รันครั้งเดียวตอนติดตั้ง — สร้างทุกแท็บพร้อม header และค่าตั้งต้น
 * รันซ้ำได้ ไม่ลบข้อมูลเดิม
 */
function setupSpreadsheet() {
  var spreadsheet = ss_();

  Object.keys(SCHEMA).forEach(function (name) {
    var sh = spreadsheet.getSheetByName(name);
    if (!sh) sh = spreadsheet.insertSheet(name);

    var headers = SCHEMA[name];
    sh.getRange(1, 1, 1, headers.length).setValues([headers])
      .setFontWeight('bold')
      .setBackground('#4a5568')
      .setFontColor('#ffffff');
    sh.setFrozenRows(1);

    // บังคับคอลัมน์ข้อความ — กันเลข 0 นำหน้ารหัสนักศึกษาหาย
    var textCols = TEXT_COLUMNS[name] || [];
    textCols.forEach(function (col) {
      var idx = headers.indexOf(col);
      if (idx >= 0) {
        sh.getRange(2, idx + 1, sh.getMaxRows() - 1, 1).setNumberFormat('@');
      }
    });

    sh.getRange(1, 1, 1, headers.length).protect()
      .setDescription('ห้ามแก้ไขแถว header')
      .setWarningOnly(true);
  });

  seedConfig_();
  seedPepper_();

  var defaultSheet = spreadsheet.getSheetByName('Sheet1') || spreadsheet.getSheetByName('ชีต1');
  if (defaultSheet && spreadsheet.getSheets().length > 1) {
    spreadsheet.deleteSheet(defaultSheet);
  }

  return 'ติดตั้งชีตเรียบร้อย — ขั้นต่อไป: รัน createAdminAccount()';
}

function seedConfig_() {
  var existing = {};
  readAll_(SHEETS.CONFIG).forEach(function (r) { existing[r.key] = true; });

  var defaults = [
    ['app_name', 'E-Borrow ระบบยืม-คืนอุปกรณ์', 'string', 'ชื่อระบบที่แสดงบนหน้าเว็บ'],
    ['default_due_days', '7', 'number', 'จำนวนวันที่ให้ยืมเป็นค่าตั้งต้น (0 = คืนภายในวันนี้)'],
    ['max_active_loans_per_student', '5', 'number', 'จำนวนรายการยืมที่เปิดค้างได้พร้อมกัน'],
    ['max_items_per_request', '10', 'number', 'จำนวนชนิดอุปกรณ์ต่อการยืม 1 ครั้ง'],
    ['block_borrow_if_overdue', 'TRUE', 'boolean', 'ห้ามยืมใหม่ถ้ามีของเกินกำหนดคืน'],
    ['session_ttl_days', '30', 'number', 'จำนวนวันที่ระบบจำการเข้าสู่ระบบ'],
    ['pin_max_attempts', '5', 'number', 'ใส่ PIN ผิดกี่ครั้งแล้วล็อก'],
    ['pin_lockout_minutes', '15', 'number', 'ล็อกนานกี่นาที'],
    ['pin_iterations', '200', 'number', 'จำนวนรอบการเข้ารหัส PIN (200 พอสำหรับห้องเรียน)'],
    ['require_photo_on_return', 'TRUE', 'boolean', 'บังคับถ่ายรูปตอนคืน'],
    ['return_photo_folder_id', '', 'string', 'ID โฟลเดอร์ Drive เก็บรูปตอนคืน'],
    ['item_photo_folder_id', '', 'string', 'ID โฟลเดอร์ Drive เก็บรูปอุปกรณ์'],
    ['max_photo_bytes', '1500000', 'number', 'ขนาดรูปสูงสุดหลังบีบอัด'],
    ['auto_approve_requests', 'FALSE', 'boolean', 'อนุมัติคำขออัตโนมัติ (ยังต้องกดจ่ายของอยู่)'],
    ['request_expiry_hours', '48', 'number', 'คำขอที่ไม่มารับเกินกี่ชั่วโมงให้ยกเลิกอัตโนมัติ'],
    ['catalog_cache_seconds', '300', 'number', 'เก็บแคตตาล็อกไว้ในแคชกี่วินาที'],
    ['levels_json', '["ปวช.1","ปวช.2","ปวช.3","ปวส.1","ปวส.2"]', 'json', 'ระดับชั้นในฟอร์มสมัคร'],
    ['departments_json', '["ช่างอิเล็กทรอนิกส์","ช่างไฟฟ้ากำลัง","ช่างยนต์","เทคนิคคอมพิวเตอร์"]', 'json', 'สาขาวิชาในฟอร์มสมัคร'],
    ['announcement', '', 'string', 'ข้อความประกาศบนหน้าแรก (เว้นว่างได้)'],
    ['catalog_version', '1', 'number', 'เลขเวอร์ชันแคตตาล็อก (ระบบจัดการเอง)']
  ];

  defaults.forEach(function (d) {
    if (!existing[d[0]]) {
      appendRow_(SHEETS.CONFIG, { key: d[0], value: d[1], type: d[2], description_th: d[3] });
    }
  });
}

/** สร้าง PEPPER เก็บใน Script Properties — ห้ามเก็บในชีต */
function seedPepper_() {
  var props = PropertiesService.getScriptProperties();
  if (!props.getProperty('PIN_PEPPER')) {
    props.setProperty('PIN_PEPPER', randomToken() + randomToken());
  }
}

// ============================================================
// ===== ส่วนที่มาจากไฟล์ Config.gs
// ============================================================

/**
 * Config.gs — อ่านค่าตั้งค่าจากแท็บ Config
 * cache ไว้ 5 นาที เพราะทุก request อ่านค่าเหล่านี้
 */

var CONFIG_CACHE_KEY = 'config_all';
var CONFIG_CACHE_TTL = 300;

function getAllConfig_() {
  var cache = CacheService.getScriptCache();
  var hit = cache.get(CONFIG_CACHE_KEY);
  if (hit) return JSON.parse(hit);

  var map = {};
  readAll_(SHEETS.CONFIG).forEach(function (r) {
    map[asString(r.key)] = asString(r.value);
  });

  try {
    cache.put(CONFIG_CACHE_KEY, JSON.stringify(map), CONFIG_CACHE_TTL);
  } catch (err) { /* cache เต็ม — อ่านจากชีตต่อไปได้ */ }

  return map;
}

function invalidateConfigCache_() {
  CacheService.getScriptCache().remove(CONFIG_CACHE_KEY);
}

function getConfig_(key, fallback) {
  var v = getAllConfig_()[key];
  return (v === undefined || v === '') ? fallback : v;
}

function getConfigNum_(key, fallback) {
  var v = getAllConfig_()[key];
  if (v === undefined || v === '') return fallback;
  var n = Number(v);
  return isNaN(n) ? fallback : n;
}

function getConfigBool_(key, fallback) {
  var v = getAllConfig_()[key];
  if (v === undefined || v === '') return fallback;
  return asBool(v);
}

function getConfigJson_(key, fallback) {
  var v = getAllConfig_()[key];
  if (!v) return fallback;
  try { return JSON.parse(v); } catch (err) { return fallback; }
}

function setConfig_(key, value) {
  var row = findRow_(SHEETS.CONFIG, 'key', key);
  if (row) {
    updateRow_(SHEETS.CONFIG, row._row, { value: value });
  } else {
    appendRow_(SHEETS.CONFIG, { key: key, value: value, type: 'string', description_th: '' });
  }
  invalidateConfigCache_();
}

/** เพิ่มเลขเวอร์ชันแคตตาล็อก — client จะรู้ว่าต้องโหลดใหม่ */
function bumpCatalogVersion_() {
  var v = getConfigNum_('catalog_version', 1);
  setConfig_('catalog_version', String(v + 1));
  CacheService.getScriptCache().remove('catalog_payload');
  return v + 1;
}

function handleAdminGetConfig_(payload, session) {
  return { config: readAll_(SHEETS.CONFIG).map(function (r) {
    return { key: r.key, value: r.value, type: r.type, description_th: r.description_th };
  }) };
}

function handleAdminSetConfig_(payload, session) {
  var key = asString(payload.key);
  if (!key) throw new AppError('BAD_REQUEST', 'ต้องระบุ key');
  setConfig_(key, asString(payload.value));
  if (key === 'levels_json' || key === 'departments_json') bumpCatalogVersion_();
  return { key: key, value: asString(payload.value) };
}

// ============================================================
// ===== ส่วนที่มาจากไฟล์ Auth.gs
// ============================================================

/**
 * Auth.gs — สมัคร เข้าสู่ระบบ เซสชัน และการตรวจสิทธิ์
 *
 * PIN 4 หลักมีแค่ 10,000 ความเป็นไปได้ จึงต้องป้องกันเป็นชั้นๆ:
 *   1. PEPPER ใน Script Properties (ไม่อยู่ในชีต) ← การป้องกันหลัก
 *      ถ้าสเปรดชีตหลุด hash ยังถอดไม่ได้เพราะ pepper ไม่ติดไปกับไฟล์
 *   2. salt ต่อคน — กัน rainbow table เดียวถอดได้ทั้งห้อง
 *   3. วนซ้ำ 200 รอบ — ถ่วงเวลาการเดาเล็กน้อย (ปรับที่ Config: pin_iterations)
 *   4. ล็อกบัญชีหลังผิด 5 ครั้ง
 *   5. บล็อก PIN ที่เดาง่าย
 *   6. ข้อความ error เหมือนกันหมด ไม่บอกว่ารหัสนักศึกษามีจริงไหม
 */

/** PIN ที่ห้ามใช้ — ในพื้นที่ 4 หลัก การห้าม PIN ง่ายได้ผลกว่าการเปลี่ยนวิธี hash */
var WEAK_PINS = [
  '0000', '1111', '2222', '3333', '4444', '5555', '6666', '7777', '8888', '9999',
  '1234', '4321', '0123', '3210', '1212', '2121', '1122', '2211',
  '1004', '2000', '2001', '2002', '2003', '2004', '2005', '2006', '2007', '2008',
  '1379', '2580', '0852', '1478', '3698', '6969', '1313', '0001', '1010', '2020'
];

function hashPin_(pin, salt) {
  var pepper = PropertiesService.getScriptProperties().getProperty('PIN_PEPPER');
  if (!pepper) throw new AppError('INTERNAL_ERROR', 'ระบบยังไม่ได้ตั้งค่า กรุณาแจ้งครู');

  var iterations = getConfigNum_('pin_iterations', 200);
  var h = pin + ':' + salt + ':' + pepper;

  for (var i = 0; i < iterations; i++) {
    h = toHex_(Utilities.computeDigest(
      Utilities.DigestAlgorithm.SHA_256, h, Utilities.Charset.UTF_8));
  }
  return h;
}

function validatePinFormat_(pin, isAdmin) {
  pin = asString(pin);
  var minLen = isAdmin ? 6 : 4;

  if (!/^\d+$/.test(pin) || pin.length < minLen || pin.length > 8) {
    throw new AppError('BAD_REQUEST',
      'PIN ต้องเป็นตัวเลข ' + minLen + (isAdmin ? '-8' : '') + ' หลัก');
  }
  if (!isAdmin && WEAK_PINS.indexOf(pin) >= 0) {
    throw new AppError('WEAK_PIN');
  }
  // เลขซ้ำกันหมด หรือเรียงติดกัน
  if (/^(\d)\1+$/.test(pin)) throw new AppError('WEAK_PIN');

  return pin;
}

function handleRegister_(payload, session, requestId) {
  var studentId = asString(payload.student_id);
  var fullName = asString(payload.full_name);
  var level = asString(payload.level);
  var department = asString(payload.department);

  if (!studentId || !fullName || !level || !department) {
    throw new AppError('BAD_REQUEST', 'กรุณากรอกข้อมูลให้ครบ');
  }
  if (!/^[0-9]{4,15}$/.test(studentId)) {
    throw new AppError('BAD_REQUEST', 'รหัสนักศึกษาต้องเป็นตัวเลข 4-15 หลัก');
  }
  if (fullName.length > 100) {
    throw new AppError('BAD_REQUEST', 'ชื่อยาวเกินไป');
  }

  var pin = validatePinFormat_(payload.pin, false);

  var lock = LockService.getScriptLock();
  if (!lock.tryLock(15000)) throw new AppError('SYSTEM_BUSY');
  try {
    if (findRow_(SHEETS.STUDENTS, 'student_id', studentId)) {
      throw new AppError('DUPLICATE_STUDENT_ID');
    }

    var salt = randomSalt();
    appendRow_(SHEETS.STUDENTS, {
      student_id: studentId,
      full_name: fullName,
      level: level,
      department: department,
      section: asString(payload.section),
      phone: asString(payload.phone),
      pin_hash: hashPin_(pin, salt),
      pin_salt: salt,
      status: 'PENDING',          // ครูต้องอนุมัติก่อน
      role: 'STUDENT',
      registered_at: nowIso(),
      failed_pin_count: 0,
      active_loan_count: 0,
      overdue_count: 0
    });
    SpreadsheetApp.flush();
  } finally {
    lock.releaseLock();
  }

  return {
    status: 'PENDING',
    message_th: 'สมัครเรียบร้อยแล้ว กรุณารอครูอนุมัติก่อนเข้าใช้งาน'
  };
}

function handleLogin_(payload, session, requestId) {
  var studentId = asString(payload.student_id);
  var pin = asString(payload.pin);

  if (!studentId || !pin) throw new AppError('INVALID_CREDENTIALS');

  var student = findRow_(SHEETS.STUDENTS, 'student_id', studentId);

  // ไม่มีบัญชีนี้ — ตอบเลย ไม่ต้องเสียเวลาเข้ารหัสทิ้งเปล่าๆ
  // (ระบบใหญ่ๆ จะแกล้ง hash เพื่อกันคนจับเวลาเดาว่ามีใครอยู่ในระบบ
  //  แต่ห้องเรียนไม่จำเป็น และทำให้ login ช้าขึ้นเท่าตัว)
  if (!student) {
    throw new AppError('INVALID_CREDENTIALS');
  }

  if (student.locked_until && !isPast(student.locked_until)) {
    throw new AppError('ACCOUNT_LOCKED');
  }

  var computed = hashPin_(pin, asString(student.pin_salt));
  if (!safeEquals(computed, asString(student.pin_hash))) {
    var fails = asNumber(student.failed_pin_count) + 1;
    var maxAttempts = getConfigNum_('pin_max_attempts', 5);
    var patch = { failed_pin_count: fails };

    if (fails >= maxAttempts) {
      var mins = getConfigNum_('pin_lockout_minutes', 15);
      var until = new Date(Date.now() + mins * 60000);
      patch.locked_until = toIso(until);
      patch.failed_pin_count = 0;
    }
    updateRow_(SHEETS.STUDENTS, student._row, patch);
    throw new AppError('INVALID_CREDENTIALS');
  }

  // ตรวจสถานะบัญชี "หลัง" ตรวจ PIN ผ่าน — ไม่งั้นระบบบอกว่าบัญชีไหนมีจริง
  var status = asString(student.status);
  if (status === 'PENDING') throw new AppError('ACCOUNT_PENDING');
  if (status === 'SUSPENDED') throw new AppError('ACCOUNT_SUSPENDED');
  if (status === 'GRADUATED') {
    throw new AppError('ACCOUNT_SUSPENDED', 'บัญชีนี้ปิดการใช้งานแล้ว');
  }

  if (asNumber(student.failed_pin_count) > 0 || student.locked_until) {
    updateRow_(SHEETS.STUDENTS, student._row, { failed_pin_count: 0, locked_until: '' });
  }

  var token = randomToken();
  var ttlDays = getConfigNum_('session_ttl_days', 30);
  var expires = new Date(Date.now() + ttlDays * 86400000);

  appendRow_(SHEETS.SESSIONS, {
    token: token,
    student_id: asString(student.student_id),
    role: asString(student.role) || 'STUDENT',
    issued_at: nowIso(),
    expires_at: toIso(expires),
    last_seen_at: nowIso(),
    user_agent: asString(payload.user_agent).slice(0, 120),
    revoked: false
  });

  return {
    token: token,
    expires_at: toIso(expires),
    student: {
      student_id: asString(student.student_id),
      full_name: asString(student.full_name),
      level: asString(student.level),
      department: asString(student.department),
      role: asString(student.role) || 'STUDENT'
    }
  };
}

/**
 * ตรวจ token — cache 5 นาทีเพราะทุก request ต้องผ่านตรงนี้
 * ถ้าไม่ cache จะอ่านทั้งแท็บ Sessions ทุกครั้งและกินโควต้าหมด
 */
function requireAuth_(token) {
  token = asString(token);
  if (!token) throw new AppError('UNAUTHENTICATED');

  var cache = CacheService.getScriptCache();
  var cacheKey = 'sess_' + token.slice(0, 32);
  var hit = cache.get(cacheKey);

  if (hit) {
    var cached = JSON.parse(hit);
    if (isPast(cached.expires_at)) {
      cache.remove(cacheKey);
      throw new AppError('SESSION_EXPIRED');
    }
    return cached;
  }

  var row = findRow_(SHEETS.SESSIONS, 'token', token);
  if (!row) throw new AppError('SESSION_EXPIRED');
  if (asBool(row.revoked)) throw new AppError('SESSION_EXPIRED');
  if (isPast(asString(row.expires_at))) throw new AppError('SESSION_EXPIRED');

  var session = {
    token: token,
    student_id: asString(row.student_id),
    role: asString(row.role) || 'STUDENT',   // อ่านจากชีตเท่านั้น ห้ามเชื่อ payload
    expires_at: asString(row.expires_at),
    _row: row._row
  };

  // อัปเดต last_seen แบบขี้เกียจ — เขียนแค่ชั่วโมงละครั้งต่อคน
  var lastSeen = parseIso(asString(row.last_seen_at));
  if (!lastSeen || Date.now() - lastSeen.getTime() > 3600000) {
    updateRow_(SHEETS.SESSIONS, row._row, { last_seen_at: nowIso() });
  }

  try {
    cache.put(cacheKey, JSON.stringify(session), 300);
  } catch (err) { /* ignore */ }

  return session;
}

function requireAdmin_(token) {
  var session = requireAuth_(token);
  if (session.role !== 'ADMIN') {
    throw new AppError('FORBIDDEN');
  }
  return session;
}

/** ดึงข้อมูลนักเรียนจาก session — ใช้ตอนต้องเช็กสิทธิ์/โควต้า */
function getStudent_(studentId) {
  var s = findRow_(SHEETS.STUDENTS, 'student_id', studentId);
  if (!s) throw new AppError('NOT_FOUND', 'ไม่พบข้อมูลนักเรียน');
  return s;
}

function handleValidateSession_(payload, session) {
  var student = getStudent_(session.student_id);
  return {
    valid: true,
    expires_at: session.expires_at,
    student: {
      student_id: asString(student.student_id),
      full_name: asString(student.full_name),
      level: asString(student.level),
      department: asString(student.department),
      role: asString(student.role) || 'STUDENT',
      active_loan_count: asNumber(student.active_loan_count),
      overdue_count: asNumber(student.overdue_count)
    }
  };
}

function handleLogout_(payload, session) {
  if (session._row) {
    updateRow_(SHEETS.SESSIONS, session._row, { revoked: true });
  }
  CacheService.getScriptCache().remove('sess_' + session.token.slice(0, 32));
  return { ok: true };
}

function handleChangePin_(payload, session) {
  var student = getStudent_(session.student_id);
  var isAdmin = session.role === 'ADMIN';

  var oldHash = hashPin_(asString(payload.old_pin), asString(student.pin_salt));
  if (!safeEquals(oldHash, asString(student.pin_hash))) {
    throw new AppError('INVALID_CREDENTIALS', 'PIN เดิมไม่ถูกต้อง');
  }

  var newPin = validatePinFormat_(payload.new_pin, isAdmin);
  var newSalt = randomSalt();

  updateRow_(SHEETS.STUDENTS, student._row, {
    pin_hash: hashPin_(newPin, newSalt),
    pin_salt: newSalt
  });

  revokeAllSessions_(session.student_id, session.token);
  return { ok: true, message_th: 'เปลี่ยน PIN เรียบร้อย' };
}

/** ยกเลิกทุก session ของคนนี้ ยกเว้นอันปัจจุบัน */
function revokeAllSessions_(studentId, keepToken) {
  var cache = CacheService.getScriptCache();
  var sessions = findRows_(SHEETS.SESSIONS, 'student_id', studentId);
  var updates = [];

  sessions.forEach(function (s) {
    if (asString(s.token) !== keepToken && !asBool(s.revoked)) {
      updates.push({ row: s._row, patch: { revoked: true } });
      cache.remove('sess_' + asString(s.token).slice(0, 32));
    }
  });

  updateRowsBatch_(SHEETS.SESSIONS, updates);
}

// ---- ติดตั้งครั้งแรก ----

/**
 * สร้างบัญชีครู — รันจาก Apps Script editor ครั้งเดียว
 * แก้ค่าสามบรรทัดข้างล่างก่อนรัน แล้วลบ PIN ออกหลังรันเสร็จ
 */
function createAdminAccount() {
  // ค่าทั้ง 3 ตัวนี้ตั้งไว้บนสุดของไฟล์แล้ว (บรรทัดที่ 40 กว่าๆ)
  var ADMIN_ID = SETUP.ADMIN_ID;
  var ADMIN_NAME = SETUP.ADMIN_NAME;
  var ADMIN_PIN = SETUP.ADMIN_PIN;

  if (findRow_(SHEETS.STUDENTS, 'student_id', ADMIN_ID)) {
    return 'มีบัญชีนี้อยู่แล้ว: ' + ADMIN_ID;
  }
  validatePinFormat_(ADMIN_PIN, true);

  var salt = randomSalt();
  appendRow_(SHEETS.STUDENTS, {
    student_id: ADMIN_ID,
    full_name: ADMIN_NAME,
    level: '-',
    department: '-',
    pin_hash: hashPin_(ADMIN_PIN, salt),
    pin_salt: salt,
    status: 'ACTIVE',
    role: 'ADMIN',
    registered_at: nowIso(),
    approved_at: nowIso(),
    approved_by: 'SYSTEM',
    failed_pin_count: 0,
    active_loan_count: 0,
    overdue_count: 0
  });

  return 'สร้างบัญชีครูเรียบร้อย: ' + ADMIN_ID + ' — เปลี่ยน PIN ทันทีหลังเข้าระบบ และลบ PIN ออกจากโค้ดนี้';
}

/**
 * ตั้ง PIN ใหม่ให้ทุกคนที่ล็อกอินไม่ได้ หลังเปลี่ยนค่า pin_iterations
 *
 * ทำไมต้องมี: PIN ถูกเข้ารหัสด้วยจำนวนรอบ ณ ตอนที่ตั้ง
 * ถ้าเปลี่ยน pin_iterations ทีหลัง รหัสเดิมจะตรวจไม่ผ่านทันที
 * (ไม่ใช่บั๊ก แต่เป็นธรรมชาติของการเข้ารหัสแบบนี้)
 *
 * วิธีใช้: แก้ 2 บรรทัดข้างล่าง แล้วกด Run
 */
function resetPinForUser() {
  var STUDENT_ID = SETUP.ADMIN_ID;   // รหัสคนที่จะตั้ง PIN ใหม่
  var NEW_PIN    = SETUP.ADMIN_PIN;  // PIN ใหม่ (ครู 6-8 หลัก / นักเรียน 4 หลัก)

  var student = findRow_(SHEETS.STUDENTS, 'student_id', STUDENT_ID);
  if (!student) return 'ไม่พบรหัส ' + STUDENT_ID + ' ในระบบ';

  var isAdmin = asString(student.role) === 'ADMIN';
  validatePinFormat_(NEW_PIN, isAdmin);

  var salt = randomSalt();
  updateRow_(SHEETS.STUDENTS, student._row, {
    pin_hash: hashPin_(NEW_PIN, salt),
    pin_salt: salt,
    failed_pin_count: 0,
    locked_until: ''
  });
  SpreadsheetApp.flush();

  return 'ตั้ง PIN ใหม่ให้ ' + STUDENT_ID + ' (' + asString(student.full_name) +
         ') เรียบร้อย — เข้าระบบได้เลย';
}

function auditLog_(actorId, actorRole, action, result, detail) {
  try {
    var detailStr = '';
    if (detail) {
      detailStr = JSON.stringify(detail);
      if (detailStr.length > 500) detailStr = detailStr.slice(0, 500) + '...';
      // ห้ามบันทึก PIN ลง log
      detailStr = detailStr.replace(/"(pin|old_pin|new_pin)":"[^"]*"/g, '"$1":"***"');
    }
    appendRow_(SHEETS.AUDIT, {
      log_id: 'LOG-' + Date.now() + '-' + Math.floor(Math.random() * 1000),
      timestamp: nowIso(),
      actor_id: actorId || '',
      actor_role: actorRole || '',
      action: action,
      target_type: '',
      target_id: '',
      detail_json: detailStr,
      result: result
    });
  } catch (err) {
    console.warn('audit log failed: ' + err);
  }
}

// ============================================================
// ===== ส่วนที่มาจากไฟล์ Stock.gs
// ============================================================

/**
 * Stock.gs — การเปลี่ยนแปลงจำนวนสต็อกทั้งหมด (แกนความถูกต้องของระบบ)
 *
 * กฎที่ต้องเป็นจริงเสมอ:
 *   ของคืนได้:     available + reserved + out == total
 *   ของสิ้นเปลือง:  available + reserved == total   (out = 0 เสมอ)
 *
 * กฎการเขียนโค้ดที่ห้ามผิด:
 *   1. ตรวจจำนวนคงเหลือ "ข้างในล็อก" เท่านั้น ค่าที่ client เห็นเก่าเสมอ
 *   2. flush() ก่อน releaseLock() ไม่งั้นคนถัดไปอ่านค่าเก่า
 *   3. อ่าน/เขียนเป็นก้อน ห้ามวนทีละเซลล์
 *   4. ห้ามเรียก Drive หรือ UrlFetch ข้างในล็อก
 *   5. เขียนตัวนับก่อนเขียนรายการ — ถ้าพังกลางคันจะได้สต็อกจองค้าง
 *      (ตรวจเจอและแก้ได้) ดีกว่ารายการที่สต็อกไม่รู้จัก (แดชบอร์ดโกหกครู)
 */

var LOCK_TIMEOUT_MS = 20000;

function withStockLock_(fn) {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(LOCK_TIMEOUT_MS)) {
    throw new AppError('SYSTEM_BUSY');
  }
  try {
    var result = fn();
    SpreadsheetApp.flush();   // ต้อง flush ก่อนปล่อยล็อก
    return result;
  } finally {
    lock.releaseLock();
  }
}

/** อ่าน Items เฉพาะที่ต้องใช้ คืนเป็น map — เรียกข้างในล็อกเสมอ */
function loadItemsMap_(itemIds) {
  var want = {};
  itemIds.forEach(function (id) { want[asString(id)] = true; });

  var map = {};
  readAll_(SHEETS.ITEMS).forEach(function (r) {
    var id = asString(r.item_id);
    if (want[id]) map[id] = r;
  });
  return map;
}

function ledgerAppend_(entry) {
  appendRow_(SHEETS.LEDGER, {
    ledger_id: 'LG-' + Date.now() + '-' + Math.floor(Math.random() * 10000),
    timestamp: nowIso(),
    item_id: entry.item_id,
    txn_id: entry.txn_id || '',
    line_id: entry.line_id || '',
    event_type: entry.event_type,
    delta_available: entry.delta_available || 0,
    delta_reserved: entry.delta_reserved || 0,
    delta_out: entry.delta_out || 0,
    delta_total: entry.delta_total || 0,
    available_after: entry.available_after,
    actor_id: entry.actor_id || '',
    reason: entry.reason || ''
  });
}

/**
 * จองสต็อก (ตอนนักเรียนกดยืม)
 * lines: [{item_id, qty}] — ต้องเรียกข้างในล็อกแล้ว
 * คืน array ของ {row, patch} ให้ผู้เรียกเขียนทีเดียว
 */
function computeReserve_(lines, itemsMap, actorId, txnId) {
  var updates = [];
  var ledgerEntries = [];

  lines.forEach(function (line) {
    var item = itemsMap[asString(line.item_id)];
    if (!item) {
      throw new AppError('NOT_FOUND', 'ไม่พบอุปกรณ์: ' + line.item_id);
    }
    if (asString(item.status) !== 'ACTIVE') {
      throw new AppError('INVALID_STATE', 'อุปกรณ์ "' + asString(item.name_th) + '" ไม่เปิดให้ยืม');
    }

    var qty = asNumber(line.qty);
    var available = asNumber(item.available_qty);

    if (qty <= 0) throw new AppError('BAD_REQUEST', 'จำนวนต้องมากกว่า 0');

    var maxPer = asNumber(item.max_per_borrow);
    if (maxPer > 0 && qty > maxPer) {
      throw new AppError('LIMIT_EXCEEDED',
        'ยืม "' + asString(item.name_th) + '" ได้ครั้งละไม่เกิน ' + maxPer + ' ' + asString(item.unit),
        { item_id: asString(item.item_id), max_per_borrow: maxPer });
    }

    if (qty > available) {
      throw new AppError('INSUFFICIENT_STOCK',
        '"' + asString(item.name_th) + '" เหลือ ' + available + ' ' + asString(item.unit),
        { item_id: asString(item.item_id), available: available, requested: qty });
    }

    var newAvailable = available - qty;
    updates.push({
      row: item._row,
      patch: {
        available_qty: newAvailable,
        reserved_qty: asNumber(item.reserved_qty) + qty,
        updated_at: nowIso()
      }
    });
    ledgerEntries.push({
      item_id: asString(item.item_id), txn_id: txnId, event_type: 'RESERVE',
      delta_available: -qty, delta_reserved: qty,
      available_after: newAvailable, actor_id: actorId
    });

    // อัปเดตค่าใน map ด้วย เผื่อ cart มีอุปกรณ์เดียวกันสองบรรทัด
    item.available_qty = newAvailable;
    item.reserved_qty = asNumber(item.reserved_qty) + qty;
  });

  return { updates: updates, ledger: ledgerEntries };
}

/** คืนการจอง (ปฏิเสธ / ยกเลิก / หมดอายุ) */
function computeUnreserve_(lines, itemsMap, actorId, txnId, eventReason) {
  var updates = [];
  var ledgerEntries = [];

  lines.forEach(function (line) {
    var item = itemsMap[asString(line.item_id)];
    if (!item) return;   // อุปกรณ์ถูกลบไปแล้ว — ข้ามไป ไม่ควรทำให้ทั้งรายการพัง

    var qty = asNumber(line.qty_approved) || asNumber(line.qty_requested);
    if (qty <= 0) return;

    var newAvailable = asNumber(item.available_qty) + qty;
    var newReserved = Math.max(0, asNumber(item.reserved_qty) - qty);

    updates.push({
      row: item._row,
      patch: { available_qty: newAvailable, reserved_qty: newReserved, updated_at: nowIso() }
    });
    ledgerEntries.push({
      item_id: asString(item.item_id), txn_id: txnId, line_id: asString(line.line_id),
      event_type: 'UNRESERVE', delta_available: qty, delta_reserved: -qty,
      available_after: newAvailable, actor_id: actorId, reason: eventReason || ''
    });

    item.available_qty = newAvailable;
    item.reserved_qty = newReserved;
  });

  return { updates: updates, ledger: ledgerEntries };
}

/**
 * จ่ายของจริง — ตรงนี้คือจุดที่ของสิ้นเปลืองกับของคืนได้แยกทางกัน
 * lines: TransactionLines rows พร้อม qty_issued ที่ครูกำหนด
 */
function computeIssue_(lines, itemsMap, actorId, txnId) {
  var updates = [];
  var ledgerEntries = [];

  lines.forEach(function (line) {
    var item = itemsMap[asString(line.item_id)];
    if (!item) throw new AppError('NOT_FOUND', 'ไม่พบอุปกรณ์: ' + line.item_id);

    var approved = asNumber(line.qty_approved);
    var issued = asNumber(line.qty_issued);
    var shortfall = approved - issued;

    if (issued < 0 || issued > approved) {
      throw new AppError('BAD_REQUEST', 'จำนวนที่จ่ายต้องอยู่ระหว่าง 0 ถึง ' + approved);
    }

    var isConsumable = asBool(line.is_consumable_snapshot);
    var available = asNumber(item.available_qty);
    var reserved = asNumber(item.reserved_qty);
    var out = asNumber(item.out_qty);
    var total = asNumber(item.total_qty);

    var patch = { updated_at: nowIso() };
    var entry = {
      item_id: asString(item.item_id), txn_id: txnId, line_id: asString(line.line_id),
      actor_id: actorId
    };

    if (isConsumable) {
      // ของสิ้นเปลือง: หายไปจากระบบถาวร ไม่แตะ out เพราะไม่รอคืน
      patch.reserved_qty = Math.max(0, reserved - issued);
      patch.total_qty = Math.max(0, total - issued);
      entry.event_type = 'CONSUME';
      entry.delta_reserved = -issued;
      entry.delta_total = -issued;
    } else {
      // ของคืนได้: ย้ายจาก reserved ไป out (available ถูกหักไปตั้งแต่ตอนจอง)
      patch.reserved_qty = Math.max(0, reserved - issued);
      patch.out_qty = out + issued;
      entry.event_type = 'ISSUE';
      entry.delta_reserved = -issued;
      entry.delta_out = issued;
    }

    // จ่ายน้อยกว่าที่อนุมัติ — ส่วนต่างคืนเข้าชั้น
    if (shortfall > 0) {
      patch.available_qty = available + shortfall;
      patch.reserved_qty = Math.max(0, patch.reserved_qty - shortfall);
      entry.delta_available = shortfall;
      entry.delta_reserved -= shortfall;
    }

    entry.available_after = (patch.available_qty !== undefined) ? patch.available_qty : available;

    updates.push({ row: item._row, patch: patch });
    ledgerEntries.push(entry);

    item.available_qty = entry.available_after;
    item.reserved_qty = patch.reserved_qty;
    if (patch.out_qty !== undefined) item.out_qty = patch.out_qty;
    if (patch.total_qty !== undefined) item.total_qty = patch.total_qty;
  });

  return { updates: updates, ledger: ledgerEntries };
}

/**
 * รับคืน — เฉพาะของคืนได้เท่านั้น
 * returns: [{line, qty_returned, qty_lost, condition}]
 */
function computeReturn_(returns, itemsMap, actorId, txnId) {
  var updates = [];
  var ledgerEntries = [];

  returns.forEach(function (r) {
    var line = r.line;
    var item = itemsMap[asString(line.item_id)];
    if (!item) throw new AppError('NOT_FOUND', 'ไม่พบอุปกรณ์: ' + line.item_id);

    if (asBool(line.is_consumable_snapshot)) {
      throw new AppError('INVALID_STATE',
        '"' + asString(line.item_name_snapshot) + '" เป็นของสิ้นเปลือง ไม่ต้องคืน');
    }

    var good = asNumber(r.qty_returned);
    var lost = asNumber(r.qty_lost);
    var outstanding = asNumber(line.qty_issued) - asNumber(line.qty_returned) - asNumber(line.qty_lost);

    if (good + lost > outstanding) {
      throw new AppError('BAD_REQUEST',
        'คืนเกินจำนวนที่ยืมไป (ค้างอยู่ ' + outstanding + ')');
    }
    if (good < 0 || lost < 0) throw new AppError('BAD_REQUEST', 'จำนวนไม่ถูกต้อง');

    var available = asNumber(item.available_qty);
    var out = asNumber(item.out_qty);
    var total = asNumber(item.total_qty);
    var patch = { updated_at: nowIso() };

    if (good > 0) {
      available += good;
      out -= good;
      patch.available_qty = available;
      patch.out_qty = Math.max(0, out);
      ledgerEntries.push({
        item_id: asString(item.item_id), txn_id: txnId, line_id: asString(line.line_id),
        event_type: 'RETURN', delta_available: good, delta_out: -good,
        available_after: available, actor_id: actorId, reason: asString(r.condition)
      });
    }

    if (lost > 0) {
      // ของหาย/พังใช้ไม่ได้ — หักออกจาก total ไม่คืนเข้า available
      out -= lost;
      total -= lost;
      patch.out_qty = Math.max(0, out);
      patch.total_qty = Math.max(0, total);
      ledgerEntries.push({
        item_id: asString(item.item_id), txn_id: txnId, line_id: asString(line.line_id),
        event_type: 'LOST', delta_out: -lost, delta_total: -lost,
        available_after: available, actor_id: actorId, reason: asString(r.note) || 'สูญหาย/ชำรุด'
      });
    }

    updates.push({ row: item._row, patch: patch });
    item.available_qty = available;
    item.out_qty = Math.max(0, out);
    item.total_qty = Math.max(0, total);
  });

  return { updates: updates, ledger: ledgerEntries };
}

function applyStockUpdates_(result) {
  updateRowsBatch_(SHEETS.ITEMS, result.updates);
  result.ledger.forEach(ledgerAppend_);
}

// ---- ปรับสต็อกด้วยมือ (ครูซื้อของใหม่ / เจอของในลิ้นชัก) ----

function handleAdminAdjustStock_(payload, session, requestId) {
  var itemId = asString(payload.item_id);
  var reason = asString(payload.reason);
  if (!itemId) throw new AppError('BAD_REQUEST', 'ต้องระบุอุปกรณ์');
  if (!reason) throw new AppError('BAD_REQUEST', 'ต้องระบุเหตุผลในการปรับสต็อก');

  return withStockLock_(function () {
    var item = findRow_(SHEETS.ITEMS, 'item_id', itemId);
    if (!item) throw new AppError('NOT_FOUND', 'ไม่พบอุปกรณ์');

    var available = asNumber(item.available_qty);
    var total = asNumber(item.total_qty);
    var patch = { updated_at: nowIso() };
    var entry = {
      item_id: itemId, event_type: 'ADJUST_IN', actor_id: session.student_id, reason: reason
    };

    if (payload.delta_total !== undefined && payload.delta_total !== null) {
      // เพิ่ม/ลดจำนวนที่มีทั้งหมด เช่น ซื้อตัวต้านทานมาเพิ่ม 100 ตัว
      var delta = asNumber(payload.delta_total);
      if (total + delta < 0 || available + delta < 0) {
        throw new AppError('BAD_REQUEST', 'ปรับแล้วจำนวนจะติดลบ');
      }
      patch.total_qty = total + delta;
      patch.available_qty = available + delta;
      entry.event_type = delta >= 0 ? 'ADJUST_IN' : 'ADJUST_OUT';
      entry.delta_total = delta;
      entry.delta_available = delta;
      entry.available_after = patch.available_qty;

    } else if (payload.set_available !== undefined && payload.set_available !== null) {
      // ตรวจนับจริงแล้วตั้งค่าใหม่ (stocktake)
      var newAvail = asNumber(payload.set_available);
      if (newAvail < 0) throw new AppError('BAD_REQUEST', 'จำนวนติดลบไม่ได้');
      var diff = newAvail - available;
      patch.available_qty = newAvail;
      patch.total_qty = Math.max(0, total + diff);
      entry.event_type = 'STOCKTAKE';
      entry.delta_available = diff;
      entry.delta_total = diff;
      entry.available_after = newAvail;

    } else {
      throw new AppError('BAD_REQUEST', 'ต้องระบุ delta_total หรือ set_available');
    }

    updateRow_(SHEETS.ITEMS, item._row, patch);
    ledgerAppend_(entry);
    bumpCatalogVersion_();

    return {
      item_id: itemId,
      available_qty: patch.available_qty,
      total_qty: patch.total_qty
    };
  });
}

// ---- กระทบยอด ----

/**
 * เทียบตัวนับกับความจริงจากรายการยืม
 * ไม่แก้ให้อัตโนมัติ — การซ่อมเงียบๆ ซ่อนบั๊กที่ทำให้เพี้ยนตั้งแต่แรก
 */
function reconcileStock_(applyFix) {
  var items = readAll_(SHEETS.ITEMS);
  var lines = readAll_(SHEETS.LINES);

  var expectedOut = {};
  var expectedReserved = {};

  lines.forEach(function (l) {
    var itemId = asString(l.item_id);
    var st = asString(l.line_status);

    if (st === 'ISSUED' || st === 'PARTIALLY_RETURNED') {
      var out = asNumber(l.qty_issued) - asNumber(l.qty_returned) - asNumber(l.qty_lost);
      if (out > 0) expectedOut[itemId] = (expectedOut[itemId] || 0) + out;
    }
    if (st === 'PENDING' || st === 'APPROVED') {
      var res = asNumber(l.qty_approved) || asNumber(l.qty_requested);
      if (res > 0) expectedReserved[itemId] = (expectedReserved[itemId] || 0) + res;
    }
  });

  var mismatches = [];
  var fixes = [];

  items.forEach(function (item) {
    var id = asString(item.item_id);
    var actualOut = asNumber(item.out_qty);
    var actualReserved = asNumber(item.reserved_qty);
    var expOut = expectedOut[id] || 0;
    var expReserved = expectedReserved[id] || 0;

    var problems = [];
    if (actualOut !== expOut) {
      problems.push('out_qty: มี ' + actualOut + ' ควรเป็น ' + expOut);
    }
    if (actualReserved !== expReserved) {
      problems.push('reserved_qty: มี ' + actualReserved + ' ควรเป็น ' + expReserved);
    }

    // ตรวจกฎรวม
    var sum = asNumber(item.available_qty) + actualReserved + actualOut;
    var total = asNumber(item.total_qty);
    if (!asBool(item.is_consumable) && sum !== total) {
      problems.push('ยอดรวมไม่ตรง: available+reserved+out=' + sum + ' แต่ total=' + total);
    }

    if (problems.length) {
      mismatches.push({
        item_id: id, name_th: asString(item.name_th), problems: problems,
        current: { available: asNumber(item.available_qty), reserved: actualReserved, out: actualOut, total: total },
        expected: { reserved: expReserved, out: expOut }
      });
      if (applyFix) {
        var correctedAvailable = total - expReserved - expOut;
        fixes.push({
          row: item._row,
          patch: {
            reserved_qty: expReserved,
            out_qty: expOut,
            available_qty: Math.max(0, correctedAvailable),
            updated_at: nowIso()
          }
        });
      }
    }
  });

  if (applyFix && fixes.length) {
    updateRowsBatch_(SHEETS.ITEMS, fixes);
    mismatches.forEach(function (m) {
      ledgerAppend_({
        item_id: m.item_id, event_type: 'STOCKTAKE',
        available_after: m.current.total - m.expected.reserved - m.expected.out,
        actor_id: 'RECONCILE', reason: 'แก้ยอดอัตโนมัติ: ' + m.problems.join('; ')
      });
    });
    bumpCatalogVersion_();
  }

  return { mismatches: mismatches, applied: applyFix ? fixes.length : 0 };
}

function handleAdminReconcile_(payload, session) {
  var apply = asBool(payload.apply);
  var result = reconcileStock_(apply);
  if (result.mismatches.length) {
    auditLog_(session.student_id, session.role, 'RECONCILE_MISMATCH',
      apply ? 'OK' : 'ERROR', { count: result.mismatches.length });
  }
  return result;
}

// ============================================================
// ===== ส่วนที่มาจากไฟล์ Catalog.gs
// ============================================================

/**
 * Catalog.gs — แคตตาล็อกอุปกรณ์
 *
 * getCatalog คืนทั้งก้อนครั้งเดียว แล้วให้ client ค้นหา/กรองเอง
 * เหตุผล: นักเรียน 30 คนเปิดพร้อมกันตอนต้นคาบ ถ้าอ่านชีตทุกครั้ง
 * จะกินโควต้าและช้า — เก็บโควต้า Apps Script ไว้ให้การเขียน
 */

function buildCatalogPayload_() {
  var categories = readAll_(SHEETS.CATEGORIES)
    .filter(function (c) { return asString(c.status) !== 'HIDDEN'; })
    .map(function (c) {
      return {
        category_id: asString(c.category_id),
        name_th: asString(c.name_th),
        name_en: asString(c.name_en),
        icon: asString(c.icon),
        sort_order: asNumber(c.sort_order)
      };
    })
    .sort(function (a, b) { return a.sort_order - b.sort_order; });

  var items = readAll_(SHEETS.ITEMS)
    .filter(function (i) { return asString(i.status) === 'ACTIVE'; })
    .map(function (i) {
      return {
        item_id: asString(i.item_id),
        name_th: asString(i.name_th),
        name_en: asString(i.name_en),
        category_id: asString(i.category_id),
        description: asString(i.description),
        photo_url: asString(i.photo_url),
        photo_file_id: asString(i.photo_file_id),
        is_consumable: asBool(i.is_consumable),
        unit: asString(i.unit) || 'ชิ้น',
        available_qty: asNumber(i.available_qty),
        total_qty: asNumber(i.total_qty),
        max_per_borrow: asNumber(i.max_per_borrow),
        default_due_days: asNumber(i.default_due_days),
        tags: asString(i.tags)
      };
    });

  return {
    categories: categories,
    items: items,
    version: getConfigNum_('catalog_version', 1),
    config: {
      max_items_per_request: getConfigNum_('max_items_per_request', 10),
      default_due_days: getConfigNum_('default_due_days', 7),
      require_photo_on_return: getConfigBool_('require_photo_on_return', true)
    }
  };
}

function handleGetCatalog_(payload, session) {
  var cache = CacheService.getScriptCache();
  var hit = cache.get('catalog_payload');
  if (hit) {
    try { return JSON.parse(hit); } catch (err) { /* cache เสีย อ่านใหม่ */ }
  }

  var data = buildCatalogPayload_();
  try {
    cache.put('catalog_payload', JSON.stringify(data),
      getConfigNum_('catalog_cache_seconds', 300));
  } catch (err) {
    // แคตตาล็อกใหญ่เกิน 100KB — client ยังใช้งานได้ แค่ช้าลง
    console.warn('catalog too large for cache');
  }
  return data;
}

/** สำรองไว้ตอนแคตตาล็อกใหญ่เกินส่งทีเดียว */
function handleListItems_(payload, session) {
  var categoryId = asString(payload.category_id);
  var q = asString(payload.q).toLowerCase();
  var onlyAvailable = asBool(payload.only_available);
  var page = Math.max(1, asNumber(payload.page) || 1);
  var pageSize = Math.min(100, asNumber(payload.page_size) || 24);

  var items = buildCatalogPayload_().items.filter(function (i) {
    if (categoryId && i.category_id !== categoryId) return false;
    if (onlyAvailable && i.available_qty <= 0) return false;
    if (q) {
      var hay = (i.name_th + ' ' + i.name_en + ' ' + i.tags).toLowerCase();
      if (hay.indexOf(q) < 0) return false;
    }
    return true;
  });

  var start = (page - 1) * pageSize;
  return {
    items: items.slice(start, start + pageSize),
    total: items.length,
    page: page
  };
}

function handleGetItem_(payload, session) {
  var itemId = asString(payload.item_id);
  var item = findRow_(SHEETS.ITEMS, 'item_id', itemId);
  if (!item || asString(item.status) === 'RETIRED') {
    throw new AppError('NOT_FOUND', 'ไม่พบอุปกรณ์นี้');
  }

  return {
    item: {
      item_id: asString(item.item_id),
      name_th: asString(item.name_th),
      name_en: asString(item.name_en),
      category_id: asString(item.category_id),
      description: asString(item.description),
      photo_url: asString(item.photo_url),
      is_consumable: asBool(item.is_consumable),
      unit: asString(item.unit) || 'ชิ้น',
      available_qty: asNumber(item.available_qty),
      total_qty: asNumber(item.total_qty),
      max_per_borrow: asNumber(item.max_per_borrow),
      default_due_days: asNumber(item.default_due_days),
      // storage_location ไม่ส่งให้นักเรียน — เป็นข้อมูลสำหรับครูหยิบของ
      storage_location: (session && session.role === 'ADMIN')
        ? asString(item.storage_location) : undefined
    }
  };
}

// ---- จัดการอุปกรณ์ (ครู) ----

function handleAdminUpsertItem_(payload, session) {
  var input = payload.item || {};
  var itemId = asString(input.item_id);
  var nameTh = asString(input.name_th);

  if (!nameTh) throw new AppError('BAD_REQUEST', 'ต้องระบุชื่ออุปกรณ์');

  return withStockLock_(function () {
    var existing = itemId ? findRow_(SHEETS.ITEMS, 'item_id', itemId) : null;

    if (existing) {
      var patch = { updated_at: nowIso() };
      ['name_th', 'name_en', 'category_id', 'description', 'unit',
       'storage_location', 'status', 'tags'].forEach(function (f) {
        if (input[f] !== undefined) patch[f] = asString(input[f]);
      });
      ['min_qty', 'max_per_borrow', 'default_due_days'].forEach(function (f) {
        if (input[f] !== undefined) patch[f] = asNumber(input[f]);
      });
      if (input.is_consumable !== undefined) {
        patch.is_consumable = asBool(input.is_consumable);
      }

      // แก้ total_qty ต้องปรับ available ตามด้วย ไม่งั้นยอดรวมเพี้ยน
      if (input.total_qty !== undefined) {
        var newTotal = asNumber(input.total_qty);
        var oldTotal = asNumber(existing.total_qty);
        var diff = newTotal - oldTotal;
        var newAvailable = asNumber(existing.available_qty) + diff;
        if (newAvailable < 0) {
          throw new AppError('BAD_REQUEST',
            'ลดจำนวนไม่ได้ เพราะมีของถูกยืมออกไปอยู่ ' + asNumber(existing.out_qty) + ' ชิ้น');
        }
        patch.total_qty = newTotal;
        patch.available_qty = newAvailable;
        if (diff !== 0) {
          ledgerAppend_({
            item_id: itemId, event_type: diff > 0 ? 'ADJUST_IN' : 'ADJUST_OUT',
            delta_total: diff, delta_available: diff, available_after: newAvailable,
            actor_id: session.student_id, reason: 'แก้ไขข้อมูลอุปกรณ์'
          });
        }
      }

      updateRow_(SHEETS.ITEMS, existing._row, patch);
      bumpCatalogVersion_();
      return { item_id: itemId, created: false };
    }

    // สร้างใหม่
    var newId = 'ITM-' + String(readAll_(SHEETS.ITEMS).length + 1).padStart(4, '0');
    while (findRow_(SHEETS.ITEMS, 'item_id', newId)) {
      newId = 'ITM-' + String(Math.floor(Math.random() * 99999)).padStart(5, '0');
    }

    var total = asNumber(input.total_qty);
    appendRow_(SHEETS.ITEMS, {
      item_id: newId,
      name_th: nameTh,
      name_en: asString(input.name_en),
      category_id: asString(input.category_id),
      description: asString(input.description),
      photo_file_id: '',
      photo_url: '',
      is_consumable: asBool(input.is_consumable),
      unit: asString(input.unit) || 'ชิ้น',
      total_qty: total,
      available_qty: total,
      reserved_qty: 0,
      out_qty: 0,
      min_qty: asNumber(input.min_qty),
      max_per_borrow: asNumber(input.max_per_borrow),
      default_due_days: input.default_due_days !== undefined
        ? asNumber(input.default_due_days) : '',
      storage_location: asString(input.storage_location),
      status: asString(input.status) || 'ACTIVE',
      tags: asString(input.tags),
      created_at: nowIso(),
      updated_at: nowIso()
    });

    if (total > 0) {
      ledgerAppend_({
        item_id: newId, event_type: 'ADJUST_IN', delta_total: total,
        delta_available: total, available_after: total,
        actor_id: session.student_id, reason: 'เพิ่มอุปกรณ์ใหม่'
      });
    }

    bumpCatalogVersion_();
    return { item_id: newId, created: true };
  });
}

function handleAdminUpsertCategory_(payload, session) {
  var input = payload.category || {};
  var catId = asString(input.category_id);
  var nameTh = asString(input.name_th);

  if (!nameTh) throw new AppError('BAD_REQUEST', 'ต้องระบุชื่อหมวดหมู่');

  var existing = catId ? findRow_(SHEETS.CATEGORIES, 'category_id', catId) : null;

  if (existing) {
    updateRow_(SHEETS.CATEGORIES, existing._row, {
      name_th: nameTh,
      name_en: asString(input.name_en),
      icon: asString(input.icon),
      sort_order: asNumber(input.sort_order),
      status: asString(input.status) || 'ACTIVE'
    });
    bumpCatalogVersion_();
    return { category_id: catId, created: false };
  }

  var newId = 'CAT-' + String(readAll_(SHEETS.CATEGORIES).length + 1).padStart(2, '0');
  while (findRow_(SHEETS.CATEGORIES, 'category_id', newId)) {
    newId = 'CAT-' + String(Math.floor(Math.random() * 999)).padStart(3, '0');
  }

  appendRow_(SHEETS.CATEGORIES, {
    category_id: newId,
    name_th: nameTh,
    name_en: asString(input.name_en),
    icon: asString(input.icon) || '📦',
    sort_order: asNumber(input.sort_order) || 99,
    parent_id: '',
    status: 'ACTIVE'
  });

  bumpCatalogVersion_();
  return { category_id: newId, created: true };
}

// ============================================================
// ===== ส่วนที่มาจากไฟล์ Borrow.gs
// ============================================================

/**
 * Borrow.gs — ยืม: ตะกร้า → คำขอ → ครูอนุมัติ → ครูจ่ายของ
 *
 * สถานะ: REQUESTED → APPROVED → IN_USE / CLOSED_CONSUMED
 *         └→ REJECTED / CANCELLED / EXPIRED (คืนการจอง)
 */

var TXN_STATUS = {
  REQUESTED: 'REQUESTED', APPROVED: 'APPROVED', REJECTED: 'REJECTED',
  CANCELLED: 'CANCELLED', EXPIRED: 'EXPIRED', IN_USE: 'IN_USE',
  PARTIALLY_RETURNED: 'PARTIALLY_RETURNED', OVERDUE: 'OVERDUE',
  RETURNED: 'RETURNED', CLOSED_CONSUMED: 'CLOSED_CONSUMED', LOST: 'LOST'
};

var OPEN_STATUSES = ['REQUESTED', 'APPROVED', 'IN_USE', 'PARTIALLY_RETURNED', 'OVERDUE'];

function nextTxnId_() {
  var stamp = dateStamp();
  var prefix = 'TXN-' + stamp + '-';
  var count = 0;
  readAll_(SHEETS.TRANSACTIONS).forEach(function (t) {
    if (asString(t.txn_id).indexOf(prefix) === 0) count++;
  });
  return prefix + String(count + 1).padStart(4, '0');
}

/** ตรวจตะกร้าก่อนกดยืมจริง — เป็นแค่การบอกล่วงหน้า ไม่ใช่การรับประกัน */
function handleValidateCart_(payload, session) {
  var lines = payload.lines || [];
  var issues = [];

  if (!lines.length) {
    return { valid: false, issues: [{ code: 'EMPTY_CART', message_th: 'ตะกร้าว่าง' }] };
  }

  var itemsMap = loadItemsMap_(lines.map(function (l) { return l.item_id; }));

  lines.forEach(function (l) {
    var item = itemsMap[asString(l.item_id)];
    var qty = asNumber(l.qty);
    if (!item) {
      issues.push({ item_id: asString(l.item_id), code: 'NOT_FOUND', message_th: 'ไม่พบอุปกรณ์' });
      return;
    }
    if (asString(item.status) !== 'ACTIVE') {
      issues.push({ item_id: asString(l.item_id), code: 'INVALID_STATE',
        message_th: asString(item.name_th) + ' ไม่เปิดให้ยืม' });
      return;
    }
    if (qty > asNumber(item.available_qty)) {
      issues.push({ item_id: asString(l.item_id), code: 'INSUFFICIENT_STOCK',
        available: asNumber(item.available_qty),
        message_th: asString(item.name_th) + ' เหลือ ' + asNumber(item.available_qty) + ' ' + asString(item.unit) });
    }
    var maxPer = asNumber(item.max_per_borrow);
    if (maxPer > 0 && qty > maxPer) {
      issues.push({ item_id: asString(l.item_id), code: 'LIMIT_EXCEEDED',
        message_th: asString(item.name_th) + ' ยืมได้ครั้งละไม่เกิน ' + maxPer });
    }
  });

  return { valid: issues.length === 0, issues: issues };
}

function handleSubmitRequest_(payload, session, requestId) {
  var lines = payload.lines || [];
  if (!lines.length) throw new AppError('BAD_REQUEST', 'ตะกร้าว่าง');

  var maxItems = getConfigNum_('max_items_per_request', 10);
  if (lines.length > maxItems) {
    throw new AppError('LIMIT_EXCEEDED', 'ยืมได้ครั้งละไม่เกิน ' + maxItems + ' ชนิด');
  }

  // รวมบรรทัดที่ซ้ำกัน — นักเรียนกดเพิ่มอุปกรณ์เดิมสองครั้ง
  var merged = {};
  lines.forEach(function (l) {
    var id = asString(l.item_id);
    if (!id) throw new AppError('BAD_REQUEST', 'ข้อมูลอุปกรณ์ไม่ครบ');
    merged[id] = (merged[id] || 0) + asNumber(l.qty);
  });
  var mergedLines = Object.keys(merged).map(function (id) {
    return { item_id: id, qty: merged[id] };
  });

  var student = getStudent_(session.student_id);

  // กันยืมเพิ่มถ้ามีของค้างเกินกำหนด
  if (getConfigBool_('block_borrow_if_overdue', true)) {
    if (asNumber(student.overdue_count) > 0) {
      throw new AppError('HAS_OVERDUE');
    }
  }

  var maxLoans = getConfigNum_('max_active_loans_per_student', 5);
  if (asNumber(student.active_loan_count) >= maxLoans) {
    throw new AppError('LIMIT_EXCEEDED',
      'คุณมีรายการยืมค้างอยู่ ' + asNumber(student.active_loan_count) +
      ' รายการแล้ว (สูงสุด ' + maxLoans + ')');
  }

  var autoApprove = getConfigBool_('auto_approve_requests', false);

  return withStockLock_(function () {
    // อ่านใหม่ข้างในล็อก — ค่าที่ client เห็นเก่าแล้วเสมอ
    var itemsMap = loadItemsMap_(mergedLines.map(function (l) { return l.item_id; }));
    var txnId = nextTxnId_();

    var stockResult = computeReserve_(mergedLines, itemsMap, session.student_id, txnId);

    // เขียนตัวนับก่อน — ถ้าพังตรงนี้จะได้สต็อกจองค้าง ซึ่งตรวจเจอและแก้ได้
    applyStockUpdates_(stockResult);

    var defaultDueDays = getConfigNum_('default_due_days', 7);
    var now = nowIso();
    var maxDue = null;
    var totalQty = 0;
    var outstandingQty = 0;

    mergedLines.forEach(function (l, idx) {
      var item = itemsMap[asString(l.item_id)];
      var isConsumable = asBool(item.is_consumable);
      var dueDays = (item.default_due_days !== '' && item.default_due_days !== undefined
        && asString(item.default_due_days) !== '')
        ? asNumber(item.default_due_days) : defaultDueDays;
      var lineDue = addDaysIso(dueDays);
      if (!maxDue || lineDue > maxDue) maxDue = lineDue;

      totalQty += asNumber(l.qty);
      if (!isConsumable) outstandingQty += asNumber(l.qty);

      appendRow_(SHEETS.LINES, {
        line_id: txnId + '-L' + (idx + 1),
        txn_id: txnId,
        item_id: asString(item.item_id),
        item_name_snapshot: asString(item.name_th),
        is_consumable_snapshot: isConsumable,
        unit_snapshot: asString(item.unit) || 'ชิ้น',
        qty_requested: asNumber(l.qty),
        qty_approved: asNumber(l.qty),
        qty_issued: 0,
        qty_returned: 0,
        qty_lost: 0,
        line_due_at: lineDue,
        line_status: autoApprove ? 'APPROVED' : 'PENDING',
        storage_location_snapshot: asString(item.storage_location),
        note: ''
      });
    });

    appendRow_(SHEETS.TRANSACTIONS, {
      txn_id: txnId,
      student_id: session.student_id,
      student_name_snapshot: asString(student.full_name),
      status: autoApprove ? TXN_STATUS.APPROVED : TXN_STATUS.REQUESTED,
      requested_at: now,
      approved_at: autoApprove ? now : '',
      due_at: maxDue,
      line_count: mergedLines.length,
      total_qty: totalQty,
      outstanding_qty: outstandingQty,
      purpose: asString(payload.purpose).slice(0, 200),
      created_at: now,
      updated_at: now
    });

    updateRow_(SHEETS.STUDENTS, student._row, {
      active_loan_count: asNumber(student.active_loan_count) + 1
    });

    bumpCatalogVersion_();

    return {
      txn_id: txnId,
      status: autoApprove ? TXN_STATUS.APPROVED : TXN_STATUS.REQUESTED,
      due_preview: maxDue,
      message_th: autoApprove
        ? 'ส่งคำขอแล้ว กรุณาไปรับอุปกรณ์จากครู'
        : 'ส่งคำขอแล้ว รอครูอนุมัติ'
    };
  });
}

/** โหลดรายการยืมพร้อมบรรทัดย่อย */
function loadTransaction_(txnId) {
  var txn = findRow_(SHEETS.TRANSACTIONS, 'txn_id', txnId);
  if (!txn) throw new AppError('NOT_FOUND', 'ไม่พบรายการยืมนี้');
  var lines = findRows_(SHEETS.LINES, 'txn_id', txnId);
  return { txn: txn, lines: lines };
}

function handleCancelRequest_(payload, session, requestId) {
  var txnId = asString(payload.txn_id);

  return withStockLock_(function () {
    var loaded = loadTransaction_(txnId);
    var txn = loaded.txn;

    // เช็กความเป็นเจ้าของ — txn_id เดาได้ ถ้าไม่เช็กนักเรียนยกเลิกของคนอื่นได้
    if (asString(txn.student_id) !== session.student_id && session.role !== 'ADMIN') {
      throw new AppError('FORBIDDEN');
    }

    var status = asString(txn.status);
    if (status !== TXN_STATUS.REQUESTED && status !== TXN_STATUS.APPROVED) {
      throw new AppError('INVALID_STATE', 'ยกเลิกได้เฉพาะรายการที่ยังไม่ได้รับของ');
    }

    releaseReservation_(txn, loaded.lines, session.student_id,
      TXN_STATUS.CANCELLED, 'นักเรียนยกเลิก');

    return { txn_id: txnId, status: TXN_STATUS.CANCELLED };
  });
}

/**
 * คืนการจองและปิดรายการ — ใช้ร่วมกันระหว่างยกเลิก/ปฏิเสธ/หมดอายุ
 * ต้องเรียกข้างในล็อกแล้ว
 */
function releaseReservation_(txn, lines, actorId, newStatus, reason) {
  var itemsMap = loadItemsMap_(lines.map(function (l) { return l.item_id; }));
  var result = computeUnreserve_(lines, itemsMap, actorId, asString(txn.txn_id), reason);
  applyStockUpdates_(result);

  var lineUpdates = lines.map(function (l) {
    return { row: l._row, patch: { line_status: 'CANCELLED' } };
  });
  updateRowsBatch_(SHEETS.LINES, lineUpdates);

  var patch = { status: newStatus, updated_at: nowIso(), cancelled_at: nowIso() };
  if (reason) patch.return_note = reason;
  updateRow_(SHEETS.TRANSACTIONS, txn._row, patch);

  decrementActiveLoan_(asString(txn.student_id));
  bumpCatalogVersion_();
}

function decrementActiveLoan_(studentId) {
  var student = findRow_(SHEETS.STUDENTS, 'student_id', studentId);
  if (student) {
    updateRow_(SHEETS.STUDENTS, student._row, {
      active_loan_count: Math.max(0, asNumber(student.active_loan_count) - 1)
    });
  }
}

function handleMyTransactions_(payload, session) {
  var filter = asString(payload.status_filter);
  var all = findRows_(SHEETS.TRANSACTIONS, 'student_id', session.student_id);
  var allLines = readAll_(SHEETS.LINES);

  var linesByTxn = {};
  allLines.forEach(function (l) {
    var t = asString(l.txn_id);
    if (!linesByTxn[t]) linesByTxn[t] = [];
    linesByTxn[t].push(l);
  });

  var active = 0, overdue = 0;
  var transactions = all.map(function (t) {
    var status = asString(t.status);
    if (OPEN_STATUSES.indexOf(status) >= 0) active++;
    if (status === TXN_STATUS.OVERDUE) overdue++;
    return serializeTransaction_(t, linesByTxn[asString(t.txn_id)] || []);
  }).filter(function (t) {
    if (!filter) return true;
    if (filter === 'open') return OPEN_STATUSES.indexOf(t.status) >= 0;
    if (filter === 'closed') return OPEN_STATUSES.indexOf(t.status) < 0;
    return t.status === filter;
  }).sort(function (a, b) {
    return (b.requested_at || '').localeCompare(a.requested_at || '');
  });

  return { transactions: transactions, summary: { active: active, overdue: overdue } };
}

function handleGetTransaction_(payload, session) {
  var loaded = loadTransaction_(asString(payload.txn_id));

  if (asString(loaded.txn.student_id) !== session.student_id && session.role !== 'ADMIN') {
    throw new AppError('FORBIDDEN');
  }

  return { transaction: serializeTransaction_(loaded.txn, loaded.lines) };
}

function serializeTransaction_(t, lines) {
  return {
    txn_id: asString(t.txn_id),
    student_id: asString(t.student_id),
    student_name: asString(t.student_name_snapshot),
    status: asString(t.status),
    requested_at: asString(t.requested_at),
    approved_at: asString(t.approved_at),
    issued_at: asString(t.issued_at),
    due_at: asString(t.due_at),
    returned_at: asString(t.returned_at),
    line_count: asNumber(t.line_count),
    total_qty: asNumber(t.total_qty),
    outstanding_qty: asNumber(t.outstanding_qty),
    purpose: asString(t.purpose),
    return_photo_url: asString(t.return_photo_url),
    return_note: asString(t.return_note),
    condition_on_return: asString(t.condition_on_return),
    is_overdue: asString(t.status) === TXN_STATUS.OVERDUE,
    lines: (lines || []).map(function (l) {
      return {
        line_id: asString(l.line_id),
        item_id: asString(l.item_id),
        item_name: asString(l.item_name_snapshot),
        is_consumable: asBool(l.is_consumable_snapshot),
        unit: asString(l.unit_snapshot),
        qty_requested: asNumber(l.qty_requested),
        qty_approved: asNumber(l.qty_approved),
        qty_issued: asNumber(l.qty_issued),
        qty_returned: asNumber(l.qty_returned),
        qty_lost: asNumber(l.qty_lost),
        outstanding: asNumber(l.qty_issued) - asNumber(l.qty_returned) - asNumber(l.qty_lost),
        line_due_at: asString(l.line_due_at),
        line_status: asString(l.line_status),
        note: asString(l.note)
      };
    })
  };
}

// ============================================================
// ===== ส่วนที่มาจากไฟล์ Return.gs
// ============================================================

/**
 * Return.gs — การคืนของ 3 ขั้นตอน
 *
 *   initiateReturn  → บันทึกว่าจะคืนอะไรบ้าง (ยังไม่ตัดสต็อก) คืน upload_token
 *   uploadReturnPhoto → อัปรูปขึ้น Drive (ช้า ไม่อยู่ในล็อก)
 *   finalizeReturn  → ตัดสต็อกจริงและปิดรายการ (อยู่ในล็อก เร็ว)
 *
 * ทำไมต้องแยก 3 ขั้น:
 *   - การเขียนไฟล์ Drive ช้าและคาดเดาไม่ได้ ห้ามอยู่ในล็อก
 *   - อัปโหลดล้มเหลวแล้ว retry ได้โดยไม่เกิดรายการคืนซ้ำ
 *   - บังคับให้มีรูปก่อนปิดรายการได้จริง
 */

var PENDING_RETURN_TTL = 3600;   // 1 ชั่วโมง

function pendingReturnKey_(returnId) {
  return 'ret_' + returnId;
}

function handleInitiateReturn_(payload, session, requestId) {
  var txnId = asString(payload.txn_id);
  var inputLines = payload.lines || [];

  if (!inputLines.length) throw new AppError('BAD_REQUEST', 'ไม่ได้เลือกรายการที่จะคืน');

  var loaded = loadTransaction_(txnId);
  var txn = loaded.txn;

  if (asString(txn.student_id) !== session.student_id && session.role !== 'ADMIN') {
    throw new AppError('FORBIDDEN');
  }

  var status = asString(txn.status);
  if ([TXN_STATUS.IN_USE, TXN_STATUS.PARTIALLY_RETURNED, TXN_STATUS.OVERDUE].indexOf(status) < 0) {
    throw new AppError('INVALID_STATE', 'รายการนี้ไม่อยู่ในสถานะที่คืนได้');
  }

  // ตรวจความถูกต้องตั้งแต่ตอนนี้ ไม่ต้องรอให้ถ่ายรูปเสร็จแล้วค่อยบอกว่าผิด
  var lineMap = {};
  loaded.lines.forEach(function (l) { lineMap[asString(l.line_id)] = l; });

  var validated = [];
  inputLines.forEach(function (input) {
    var line = lineMap[asString(input.line_id)];
    if (!line) throw new AppError('NOT_FOUND', 'ไม่พบรายการย่อย: ' + input.line_id);

    if (asBool(line.is_consumable_snapshot)) {
      throw new AppError('INVALID_STATE',
        '"' + asString(line.item_name_snapshot) + '" เป็นของสิ้นเปลือง ไม่ต้องคืน');
    }

    var qtyReturned = asNumber(input.qty_returned);
    var qtyLost = asNumber(input.qty_lost);
    var outstanding = asNumber(line.qty_issued) - asNumber(line.qty_returned) - asNumber(line.qty_lost);

    if (qtyReturned + qtyLost <= 0) return;
    if (qtyReturned + qtyLost > outstanding) {
      throw new AppError('BAD_REQUEST',
        '"' + asString(line.item_name_snapshot) + '" ค้างอยู่ ' + outstanding + ' ชิ้น');
    }

    validated.push({
      line_id: asString(line.line_id),
      qty_returned: qtyReturned,
      qty_lost: qtyLost,
      condition: asString(input.condition) || 'OK',
      note: asString(input.note)
    });
  });

  if (!validated.length) throw new AppError('BAD_REQUEST', 'ไม่มีรายการที่จะคืน');

  var returnId = 'RET-' + Date.now() + '-' + Math.floor(Math.random() * 10000);
  var uploadToken = randomToken().slice(0, 32);

  var pending = {
    return_id: returnId,
    upload_token: uploadToken,
    txn_id: txnId,
    student_id: asString(txn.student_id),
    actor_id: session.student_id,
    lines: validated,
    photo_file_id: '',
    photo_url: '',
    created_at: nowIso()
  };

  CacheService.getScriptCache().put(
    pendingReturnKey_(returnId), JSON.stringify(pending), PENDING_RETURN_TTL);

  return {
    return_id: returnId,
    upload_token: uploadToken,
    upload_required: getConfigBool_('require_photo_on_return', true),
    lines: validated
  };
}

function loadPendingReturn_(returnId, uploadToken) {
  var raw = CacheService.getScriptCache().get(pendingReturnKey_(returnId));
  if (!raw) {
    throw new AppError('INVALID_STATE', 'การคืนหมดเวลา กรุณาเริ่มใหม่');
  }
  var pending = JSON.parse(raw);

  // upload_token เป็นกุญแจใช้ครั้งเดียว — return_id หลุดไปเฉยๆ แนบรูปไม่ได้
  if (!safeEquals(pending.upload_token, asString(uploadToken))) {
    throw new AppError('FORBIDDEN');
  }
  return pending;
}

function savePendingReturn_(pending) {
  CacheService.getScriptCache().put(
    pendingReturnKey_(pending.return_id), JSON.stringify(pending), PENDING_RETURN_TTL);
}

/**
 * อัปรูปขึ้น Drive — ไม่อยู่ในล็อก เพราะ Drive ช้าและคาดเดาไม่ได้
 * รูปถูกบีบอัดฝั่ง client มาแล้ว (ดู web/js/image.js)
 */
function handleUploadReturnPhoto_(payload, session, requestId) {
  var pending = loadPendingReturn_(asString(payload.return_id), payload.upload_token);

  if (pending.student_id !== session.student_id && session.role !== 'ADMIN') {
    throw new AppError('FORBIDDEN');
  }

  var b64 = asString(payload.data_base64);
  if (!b64) throw new AppError('BAD_REQUEST', 'ไม่พบข้อมูลรูป');

  var maxBytes = getConfigNum_('max_photo_bytes', 1500000);
  // base64 ยาวกว่าไบต์จริง ~33%
  if (b64.length * 0.75 > maxBytes) {
    throw new AppError('PHOTO_TOO_LARGE',
      'รูปใหญ่เกินไป กรุณาถ่ายใหม่');
  }

  var mimeType = asString(payload.mime_type) || 'image/jpeg';
  if (mimeType.indexOf('image/') !== 0) {
    throw new AppError('BAD_REQUEST', 'ไฟล์ต้องเป็นรูปภาพเท่านั้น');
  }

  var bytes;
  try {
    bytes = Utilities.base64Decode(b64);
  } catch (err) {
    throw new AppError('BAD_REQUEST', 'ข้อมูลรูปเสียหาย กรุณาถ่ายใหม่');
  }

  var ext = mimeType === 'image/png' ? 'png' : 'jpg';
  var filename = pending.txn_id + '_' + pending.student_id + '_' + Date.now() + '.' + ext;
  var blob = Utilities.newBlob(bytes, mimeType, filename);

  var folder = getReturnPhotoFolder_();
  var file = folder.createFile(blob);
  // แชร์แบบมีลิงก์ เพื่อให้ <img> บน GitHub Pages โหลดได้โดยไม่ต้องผ่าน Apps Script
  // (ถ้า proxy ทุกรูปผ่าน Apps Script จะกินโควต้าหมดภายในสัปดาห์เดียว)
  file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);

  var fileId = file.getId();
  pending.photo_file_id = fileId;
  pending.photo_url = driveThumbnailUrl_(fileId, 800);
  savePendingReturn_(pending);

  return { file_id: fileId, url: pending.photo_url, complete: true };
}

/**
 * URL รูปจาก Drive — เก็บ file_id ไว้เสมอเพื่อสร้าง URL ใหม่ได้
 * ถ้า Google เปลี่ยนรูปแบบลิงก์ แก้แค่ฟังก์ชันนี้ฟังก์ชันเดียว
 */
function driveThumbnailUrl_(fileId, width) {
  return 'https://drive.google.com/thumbnail?id=' + fileId + '&sz=w' + (width || 400);
}

function getReturnPhotoFolder_() {
  var rootId = getConfig_('return_photo_folder_id', '');
  var root;

  if (rootId) {
    try {
      root = DriveApp.getFolderById(rootId);
    } catch (err) {
      throw new AppError('INTERNAL_ERROR', 'ตั้งค่าโฟลเดอร์รูปไม่ถูกต้อง กรุณาแจ้งครู');
    }
  } else {
    root = getOrCreateFolder_(DriveApp.getRootFolder(), 'E-Borrow');
    root = getOrCreateFolder_(root, 'Returns');
    setConfig_('return_photo_folder_id', root.getId());
  }

  // แยกโฟลเดอร์รายเดือน — โฟลเดอร์แบนที่มีไฟล์เป็นพันเปิดดูไม่ไหว และครูจะเข้าไปดู
  return getOrCreateFolder_(root, yearMonth());
}

function getOrCreateFolder_(parent, name) {
  var it = parent.getFoldersByName(name);
  return it.hasNext() ? it.next() : parent.createFolder(name);
}

function handleFinalizeReturn_(payload, session, requestId) {
  var pending = loadPendingReturn_(asString(payload.return_id), payload.upload_token);

  if (pending.student_id !== session.student_id && session.role !== 'ADMIN') {
    throw new AppError('FORBIDDEN');
  }

  if (getConfigBool_('require_photo_on_return', true) && !pending.photo_file_id) {
    throw new AppError('PHOTO_REQUIRED');
  }

  var result = processReturn_({
    txn_id: pending.txn_id,
    lines: pending.lines,
    photo_file_id: pending.photo_file_id,
    photo_url: pending.photo_url
  }, session, false);

  CacheService.getScriptCache().remove(pendingReturnKey_(pending.return_id));
  return result;
}

/**
 * ตัดสต็อกและปิดรายการ — ใช้ร่วมกันระหว่างนักเรียนคืนเองกับครูรับคืนแทน
 * byAdmin = true แปลว่าครูกดรับคืนโดยตรง (ข้ามการบังคับถ่ายรูป)
 */
function processReturn_(payload, session, byAdmin) {
  var txnId = asString(payload.txn_id);
  var inputLines = payload.lines || [];

  return withStockLock_(function () {
    var loaded = loadTransaction_(txnId);
    var txn = loaded.txn;

    var status = asString(txn.status);
    if ([TXN_STATUS.IN_USE, TXN_STATUS.PARTIALLY_RETURNED, TXN_STATUS.OVERDUE].indexOf(status) < 0) {
      throw new AppError('INVALID_STATE', 'รายการนี้ไม่อยู่ในสถานะที่คืนได้');
    }

    var lineMap = {};
    loaded.lines.forEach(function (l) { lineMap[asString(l.line_id)] = l; });

    // ครูกดรับคืนโดยไม่ระบุรายการ = คืนทุกอย่างที่ค้างอยู่
    if (byAdmin && !inputLines.length) {
      inputLines = loaded.lines.filter(function (l) {
        if (asBool(l.is_consumable_snapshot)) return false;
        return asNumber(l.qty_issued) - asNumber(l.qty_returned) - asNumber(l.qty_lost) > 0;
      }).map(function (l) {
        return {
          line_id: asString(l.line_id),
          qty_returned: asNumber(l.qty_issued) - asNumber(l.qty_returned) - asNumber(l.qty_lost),
          qty_lost: 0,
          condition: asString(payload.condition) || 'OK'
        };
      });
    }

    if (!inputLines.length) throw new AppError('BAD_REQUEST', 'ไม่มีรายการที่จะคืน');

    var returns = [];
    var lineUpdates = [];

    inputLines.forEach(function (input) {
      var line = lineMap[asString(input.line_id)];
      if (!line) throw new AppError('NOT_FOUND', 'ไม่พบรายการย่อย');

      var qtyReturned = asNumber(input.qty_returned);
      var qtyLost = asNumber(input.qty_lost);
      if (qtyReturned + qtyLost <= 0) return;

      returns.push({
        line: line, qty_returned: qtyReturned, qty_lost: qtyLost,
        condition: asString(input.condition) || 'OK', note: asString(input.note)
      });

      var newReturned = asNumber(line.qty_returned) + qtyReturned;
      var newLost = asNumber(line.qty_lost) + qtyLost;
      var outstanding = asNumber(line.qty_issued) - newReturned - newLost;

      lineUpdates.push({
        row: line._row,
        patch: {
          qty_returned: newReturned,
          qty_lost: newLost,
          line_status: outstanding <= 0 ? (newLost > 0 && newReturned === 0 ? 'LOST' : 'RETURNED')
                                        : 'PARTIALLY_RETURNED',
          note: asString(input.note) || asString(line.note)
        }
      });
    });

    var itemsMap = loadItemsMap_(returns.map(function (r) { return r.line.item_id; }));
    var stockResult = computeReturn_(returns, itemsMap, session.student_id, txnId);

    applyStockUpdates_(stockResult);
    updateRowsBatch_(SHEETS.LINES, lineUpdates);

    if (payload.photo_file_id) {
      updateRow_(SHEETS.TRANSACTIONS, txn._row, {
        return_photo_file_id: payload.photo_file_id,
        return_photo_url: payload.photo_url || '',
        updated_at: nowIso()
      });
      txn.return_photo_file_id = payload.photo_file_id;
    }

    var anyLost = returns.some(function (r) { return r.qty_lost > 0; });
    var condition = anyLost ? 'PARTIAL' : (asString(payload.condition) || 'OK');
    var outstanding = recomputeTransactionClosure_(
      txn, session.student_id, condition, asString(payload.note));

    bumpCatalogVersion_();

    return {
      txn_id: txnId,
      status: outstanding <= 0 ? TXN_STATUS.RETURNED : TXN_STATUS.PARTIALLY_RETURNED,
      outstanding_qty: Math.max(0, outstanding),
      photo_url: payload.photo_url || asString(txn.return_photo_url),
      message_th: outstanding <= 0
        ? 'คืนอุปกรณ์ครบแล้ว ขอบคุณครับ'
        : 'คืนบางส่วนแล้ว ยังค้างอีก ' + outstanding + ' ชิ้น'
    };
  });
}

function handleAdminUploadItemPhoto_(payload, session) {
  var itemId = asString(payload.item_id);
  var item = findRow_(SHEETS.ITEMS, 'item_id', itemId);
  if (!item) throw new AppError('NOT_FOUND', 'ไม่พบอุปกรณ์');

  var b64 = asString(payload.data_base64);
  if (!b64) throw new AppError('BAD_REQUEST', 'ไม่พบข้อมูลรูป');

  var maxBytes = getConfigNum_('max_photo_bytes', 1500000);
  if (b64.length * 0.75 > maxBytes) throw new AppError('PHOTO_TOO_LARGE');

  var mimeType = asString(payload.mime_type) || 'image/jpeg';
  var bytes = Utilities.base64Decode(b64);
  var ext = mimeType === 'image/png' ? 'png' : 'jpg';
  var blob = Utilities.newBlob(bytes, mimeType, itemId + '_' + Date.now() + '.' + ext);

  var folderId = getConfig_('item_photo_folder_id', '');
  var folder;
  if (folderId) {
    folder = DriveApp.getFolderById(folderId);
  } else {
    var root = getOrCreateFolder_(DriveApp.getRootFolder(), 'E-Borrow');
    folder = getOrCreateFolder_(root, 'Items');
    setConfig_('item_photo_folder_id', folder.getId());
  }

  var file = folder.createFile(blob);
  file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
  var fileId = file.getId();

  // ลบรูปเดิมทิ้ง ไม่ให้ Drive รก
  var oldId = asString(item.photo_file_id);
  if (oldId) {
    try { DriveApp.getFileById(oldId).setTrashed(true); } catch (err) { /* ไม่มีแล้วก็ข้าม */ }
  }

  updateRow_(SHEETS.ITEMS, item._row, {
    photo_file_id: fileId,
    photo_url: driveThumbnailUrl_(fileId, 400),
    updated_at: nowIso()
  });
  bumpCatalogVersion_();

  return { file_id: fileId, url: driveThumbnailUrl_(fileId, 400) };
}

// ============================================================
// ===== ส่วนที่มาจากไฟล์ Admin.gs
// ============================================================

/**
 * Admin.gs — งานของครู: อนุมัติ จ่ายของ รับคืน แดชบอร์ด
 *
 * หัวใจคือ adminPendingRequests ที่คืน "ใบรายการหยิบของ" เรียงตามตำแหน่งตู้
 * ทำให้การกดยืนยันส่งมอบเร็วกว่าการให้นักเรียนมาต่อคิวที่ตู้
 */

function handleAdminPendingStudents_(payload, session) {
  var pending = readAll_(SHEETS.STUDENTS).filter(function (s) {
    return asString(s.status) === 'PENDING';
  }).map(function (s) {
    return {
      student_id: asString(s.student_id),
      full_name: asString(s.full_name),
      level: asString(s.level),
      department: asString(s.department),
      section: asString(s.section),
      phone: asString(s.phone),
      registered_at: asString(s.registered_at)
    };
  });
  return { students: pending };
}

function handleAdminApproveStudent_(payload, session) {
  var studentId = asString(payload.student_id);
  var approve = payload.approve !== false;

  var student = findRow_(SHEETS.STUDENTS, 'student_id', studentId);
  if (!student) throw new AppError('NOT_FOUND', 'ไม่พบนักเรียนคนนี้');

  updateRow_(SHEETS.STUDENTS, student._row, {
    status: approve ? 'ACTIVE' : 'SUSPENDED',
    approved_at: nowIso(),
    approved_by: session.student_id,
    notes: asString(payload.note) || asString(student.notes)
  });

  return {
    student_id: studentId,
    status: approve ? 'ACTIVE' : 'SUSPENDED',
    message_th: approve ? 'อนุมัติแล้ว' : 'ปฏิเสธแล้ว'
  };
}

function handleAdminListStudents_(payload, session) {
  var level = asString(payload.level);
  var department = asString(payload.department);
  var status = asString(payload.status);
  var q = asString(payload.q).toLowerCase();

  var students = readAll_(SHEETS.STUDENTS).filter(function (s) {
    if (level && asString(s.level) !== level) return false;
    if (department && asString(s.department) !== department) return false;
    if (status && asString(s.status) !== status) return false;
    if (q) {
      var hay = (asString(s.full_name) + ' ' + asString(s.student_id)).toLowerCase();
      if (hay.indexOf(q) < 0) return false;
    }
    return true;
  }).map(function (s) {
    return {
      student_id: asString(s.student_id),
      full_name: asString(s.full_name),
      level: asString(s.level),
      department: asString(s.department),
      section: asString(s.section),
      phone: asString(s.phone),
      status: asString(s.status),
      role: asString(s.role),
      active_loan_count: asNumber(s.active_loan_count),
      overdue_count: asNumber(s.overdue_count),
      registered_at: asString(s.registered_at)
    };
  });

  return { students: students };
}

function handleAdminResetPin_(payload, session) {
  var studentId = asString(payload.student_id);
  var student = findRow_(SHEETS.STUDENTS, 'student_id', studentId);
  if (!student) throw new AppError('NOT_FOUND', 'ไม่พบนักเรียนคนนี้');

  var isTargetAdmin = asString(student.role) === 'ADMIN';
  var newPin = validatePinFormat_(payload.new_pin, isTargetAdmin);
  var salt = randomSalt();

  updateRow_(SHEETS.STUDENTS, student._row, {
    pin_hash: hashPin_(newPin, salt),
    pin_salt: salt,
    failed_pin_count: 0,
    locked_until: ''
  });

  revokeAllSessions_(studentId, null);
  return { ok: true, message_th: 'รีเซ็ต PIN เรียบร้อย แจ้ง PIN ใหม่ให้นักเรียน' };
}

/**
 * คิวคำขอ + ใบรายการหยิบของ
 * ใบหยิบของเรียงตามตำแหน่งตู้ ครูเดินหยิบรอบเดียวจบ
 */
function handleAdminPendingRequests_(payload, session) {
  var txns = readAll_(SHEETS.TRANSACTIONS).filter(function (t) {
    var s = asString(t.status);
    return s === TXN_STATUS.REQUESTED || s === TXN_STATUS.APPROVED;
  });

  var allLines = readAll_(SHEETS.LINES);
  var linesByTxn = {};
  allLines.forEach(function (l) {
    var t = asString(l.txn_id);
    if (!linesByTxn[t]) linesByTxn[t] = [];
    linesByTxn[t].push(l);
  });

  var pickList = [];
  var transactions = txns.map(function (t) {
    var lines = linesByTxn[asString(t.txn_id)] || [];
    lines.forEach(function (l) {
      pickList.push({
        txn_id: asString(t.txn_id),
        student_name: asString(t.student_name_snapshot),
        item_name: asString(l.item_name_snapshot),
        qty: asNumber(l.qty_approved) || asNumber(l.qty_requested),
        unit: asString(l.unit_snapshot),
        storage_location: asString(l.storage_location_snapshot) || 'ไม่ระบุตำแหน่ง',
        is_consumable: asBool(l.is_consumable_snapshot)
      });
    });
    return serializeTransaction_(t, lines);
  }).sort(function (a, b) {
    return (a.requested_at || '').localeCompare(b.requested_at || '');
  });

  pickList.sort(function (a, b) {
    return a.storage_location.localeCompare(b.storage_location, 'th');
  });

  var awaitingIssue = transactions.filter(function (t) {
    return t.status === TXN_STATUS.APPROVED;
  }).length;

  return {
    transactions: transactions,
    pick_list: pickList,
    counts: {
      awaiting_approval: transactions.length - awaitingIssue,
      awaiting_issue: awaitingIssue
    }
  };
}

function handleAdminApproveRequest_(payload, session, requestId) {
  var txnId = asString(payload.txn_id);
  var overrides = payload.line_overrides || [];

  return withStockLock_(function () {
    var loaded = loadTransaction_(txnId);
    var txn = loaded.txn;

    if (asString(txn.status) !== TXN_STATUS.REQUESTED) {
      throw new AppError('INVALID_STATE', 'รายการนี้ผ่านขั้นตอนอนุมัติไปแล้ว');
    }

    var overrideMap = {};
    overrides.forEach(function (o) {
      overrideMap[asString(o.line_id)] = asNumber(o.qty_approved);
    });

    var itemsMap = loadItemsMap_(loaded.lines.map(function (l) { return l.item_id; }));
    var lineUpdates = [];
    var stockUpdates = { updates: [], ledger: [] };
    var outstanding = 0;

    loaded.lines.forEach(function (l) {
      var lineId = asString(l.line_id);
      var approved = asNumber(l.qty_approved);

      // ครูลดจำนวน — ส่วนต่างต้องคืนเข้าชั้นทันที ไม่งั้นจองค้าง
      if (overrideMap.hasOwnProperty(lineId)) {
        var newApproved = overrideMap[lineId];
        if (newApproved < 0 || newApproved > approved) {
          throw new AppError('BAD_REQUEST', 'จำนวนที่อนุมัติต้องอยู่ระหว่าง 0 ถึง ' + approved);
        }
        var diff = approved - newApproved;
        if (diff > 0) {
          var item = itemsMap[asString(l.item_id)];
          if (item) {
            var newAvail = asNumber(item.available_qty) + diff;
            stockUpdates.updates.push({
              row: item._row,
              patch: {
                available_qty: newAvail,
                reserved_qty: Math.max(0, asNumber(item.reserved_qty) - diff),
                updated_at: nowIso()
              }
            });
            stockUpdates.ledger.push({
              item_id: asString(item.item_id), txn_id: txnId, line_id: lineId,
              event_type: 'UNRESERVE', delta_available: diff, delta_reserved: -diff,
              available_after: newAvail, actor_id: session.student_id,
              reason: 'ครูลดจำนวนที่อนุมัติ'
            });
            item.available_qty = newAvail;
            item.reserved_qty = Math.max(0, asNumber(item.reserved_qty) - diff);
          }
        }
        approved = newApproved;
      }

      lineUpdates.push({
        row: l._row,
        patch: { qty_approved: approved, line_status: approved > 0 ? 'APPROVED' : 'CANCELLED' }
      });
      if (!asBool(l.is_consumable_snapshot)) outstanding += approved;
    });

    if (stockUpdates.updates.length) applyStockUpdates_(stockUpdates);
    updateRowsBatch_(SHEETS.LINES, lineUpdates);

    updateRow_(SHEETS.TRANSACTIONS, txn._row, {
      status: TXN_STATUS.APPROVED,
      approved_at: nowIso(),
      handled_by: session.student_id,
      outstanding_qty: outstanding,
      updated_at: nowIso()
    });

    if (stockUpdates.updates.length) bumpCatalogVersion_();

    return { txn_id: txnId, status: TXN_STATUS.APPROVED };
  });
}

function handleAdminRejectRequest_(payload, session, requestId) {
  var txnId = asString(payload.txn_id);
  var reason = asString(payload.reason) || 'ครูปฏิเสธคำขอ';

  return withStockLock_(function () {
    var loaded = loadTransaction_(txnId);
    if (asString(loaded.txn.status) !== TXN_STATUS.REQUESTED) {
      throw new AppError('INVALID_STATE', 'ปฏิเสธได้เฉพาะคำขอที่ยังไม่อนุมัติ');
    }
    releaseReservation_(loaded.txn, loaded.lines, session.student_id,
      TXN_STATUS.REJECTED, reason);
    return { txn_id: txnId, status: TXN_STATUS.REJECTED };
  });
}

/**
 * จ่ายของจริง — จุดที่ของเปลี่ยนมือและกำหนดคืนเริ่มนับ
 * ถ้าทุกบรรทัดเป็นของสิ้นเปลือง รายการปิดทันที (CLOSED_CONSUMED)
 */
function handleAdminIssueTransaction_(payload, session, requestId) {
  var txnId = asString(payload.txn_id);
  var overrides = payload.line_overrides || [];

  return withStockLock_(function () {
    var loaded = loadTransaction_(txnId);
    var txn = loaded.txn;
    var status = asString(txn.status);

    // อนุญาตให้จ่ายจาก REQUESTED เลยได้ (ปุ่ม "อนุมัติ+จ่าย" ในคลิกเดียว
    // สำหรับกรณีที่ครูถือของอยู่ในมือแล้ว)
    if (status !== TXN_STATUS.APPROVED && status !== TXN_STATUS.REQUESTED) {
      throw new AppError('INVALID_STATE', 'รายการนี้จ่ายของไปแล้ว');
    }

    var overrideMap = {};
    overrides.forEach(function (o) {
      overrideMap[asString(o.line_id)] = asNumber(o.qty_issued);
    });

    var itemsMap = loadItemsMap_(loaded.lines.map(function (l) { return l.item_id; }));
    var issueLines = [];
    var lineUpdates = [];
    var outstanding = 0;
    var hasReturnable = false;
    var maxDue = null;

    loaded.lines.forEach(function (l) {
      var lineId = asString(l.line_id);
      var approved = asNumber(l.qty_approved);
      var issued = overrideMap.hasOwnProperty(lineId) ? overrideMap[lineId] : approved;
      var isConsumable = asBool(l.is_consumable_snapshot);

      issueLines.push({
        line_id: lineId, item_id: asString(l.item_id),
        qty_approved: approved, qty_issued: issued,
        is_consumable_snapshot: isConsumable
      });

      var lineStatus;
      if (issued <= 0) {
        lineStatus = 'CANCELLED';
      } else if (isConsumable) {
        lineStatus = 'CONSUMED';     // ของสิ้นเปลืองปิดตั้งแต่จ่าย
      } else {
        lineStatus = 'ISSUED';
        hasReturnable = true;
        outstanding += issued;
        var ld = asString(l.line_due_at);
        if (!maxDue || ld > maxDue) maxDue = ld;
      }

      lineUpdates.push({ row: l._row, patch: { qty_issued: issued, line_status: lineStatus } });
    });

    var stockResult = computeIssue_(issueLines, itemsMap, session.student_id, txnId);
    applyStockUpdates_(stockResult);
    updateRowsBatch_(SHEETS.LINES, lineUpdates);

    var newStatus = hasReturnable ? TXN_STATUS.IN_USE : TXN_STATUS.CLOSED_CONSUMED;
    var now = nowIso();
    var txnPatch = {
      status: newStatus,
      issued_at: now,
      due_at: maxDue || asString(txn.due_at),
      handled_by: session.student_id,
      outstanding_qty: outstanding,
      updated_at: now
    };
    if (!hasReturnable) txnPatch.returned_at = now;
    if (status === TXN_STATUS.REQUESTED) txnPatch.approved_at = now;

    updateRow_(SHEETS.TRANSACTIONS, txn._row, txnPatch);

    // ของสิ้นเปลืองล้วน = ปิดรายการทันที ปลดโควต้าให้นักเรียน
    if (!hasReturnable) decrementActiveLoan_(asString(txn.student_id));

    bumpCatalogVersion_();

    return {
      txn_id: txnId,
      status: newStatus,
      due_at: txnPatch.due_at,
      message_th: hasReturnable
        ? 'จ่ายของเรียบร้อย กำหนดคืน ' + formatThaiDate_(txnPatch.due_at)
        : 'จ่ายของสิ้นเปลืองเรียบร้อย ปิดรายการแล้ว'
    };
  });
}

function handleAdminMarkLost_(payload, session, requestId) {
  var txnId = asString(payload.txn_id);
  var lineId = asString(payload.line_id);
  var qty = asNumber(payload.qty);
  var reason = asString(payload.reason) || 'ครูบันทึกว่าสูญหาย';

  return withStockLock_(function () {
    var loaded = loadTransaction_(txnId);
    var line = loaded.lines.filter(function (l) {
      return asString(l.line_id) === lineId;
    })[0];
    if (!line) throw new AppError('NOT_FOUND', 'ไม่พบรายการย่อยนี้');

    var itemsMap = loadItemsMap_([line.item_id]);
    var result = computeReturn_([{
      line: line, qty_returned: 0, qty_lost: qty, condition: 'LOST', note: reason
    }], itemsMap, session.student_id, txnId);
    applyStockUpdates_(result);

    var newLost = asNumber(line.qty_lost) + qty;
    var outstanding = asNumber(line.qty_issued) - asNumber(line.qty_returned) - newLost;
    updateRowsBatch_(SHEETS.LINES, [{
      row: line._row,
      patch: {
        qty_lost: newLost,
        line_status: outstanding <= 0 ? 'LOST' : 'PARTIALLY_RETURNED',
        note: reason
      }
    }]);

    recomputeTransactionClosure_(loaded.txn, session.student_id, 'LOST', reason);
    bumpCatalogVersion_();

    return { txn_id: txnId, line_id: lineId, qty_lost: newLost };
  });
}

/** ตรวจว่ารายการปิดได้หรือยัง หลังมีการคืน/แจ้งหาย */
function recomputeTransactionClosure_(txn, actorId, condition, note) {
  var lines = findRows_(SHEETS.LINES, 'txn_id', asString(txn.txn_id));
  var outstanding = 0;

  lines.forEach(function (l) {
    if (asBool(l.is_consumable_snapshot)) return;
    var st = asString(l.line_status);
    if (st === 'CANCELLED') return;
    outstanding += asNumber(l.qty_issued) - asNumber(l.qty_returned) - asNumber(l.qty_lost);
  });

  var patch = { outstanding_qty: Math.max(0, outstanding), updated_at: nowIso() };

  if (outstanding <= 0) {
    patch.status = TXN_STATUS.RETURNED;
    patch.returned_at = nowIso();
    if (condition) patch.condition_on_return = condition;
    if (note) patch.return_note = note;
    updateRow_(SHEETS.TRANSACTIONS, txn._row, patch);
    // ปิดรายการแล้วต้องอัปเดตตัวนับ 2 ตัวของนักเรียนพร้อมกันในการเขียนครั้งเดียว
    // ถ้าแยกเขียนสองครั้ง ครั้งที่สองจะอ่านค่าเก่า (ยังไม่ flush) แล้วทับครั้งแรก
    closeLoanForStudent_(asString(txn.student_id), asString(txn.txn_id));
  } else {
    patch.status = TXN_STATUS.PARTIALLY_RETURNED;
    updateRow_(SHEETS.TRANSACTIONS, txn._row, patch);
  }

  return outstanding;
}

/**
 * ปิดรายการยืม 1 ใบ แล้วอัปเดตตัวนับของนักเรียนใน "การเขียนครั้งเดียว"
 *
 * ทำไมต้องรวมเป็นครั้งเดียว:
 * updateRow_ อ่านทั้งแถวแล้วเขียนกลับทั้งแถว และ Apps Script ไม่ flush ทันที
 * ถ้าเรียกสองครั้งติดกันบนแถวเดียวกัน ครั้งที่สองจะอ่านค่าก่อนหน้าที่ยังไม่ commit
 * แล้วเขียนทับ ทำให้การเปลี่ยนแปลงครั้งแรกหายไป
 * ผลคือ active_loan_count ไม่เคยลด จนนักเรียนยืมไม่ได้อีกเลยเมื่อครบโควต้า
 *
 * closedTxnId = รายการที่เพิ่งปิดในรอบนี้ ต้องไม่นับเป็น overdue
 * เพราะการเขียนสถานะ RETURNED ก็ยังไม่ flush เช่นกัน
 */
function closeLoanForStudent_(studentId, closedTxnId) {
  var student = findRow_(SHEETS.STUDENTS, 'student_id', studentId);
  if (!student) return;

  var overdue = findRows_(SHEETS.TRANSACTIONS, 'student_id', studentId)
    .filter(function (t) {
      if (closedTxnId && asString(t.txn_id) === closedTxnId) return false;
      return asString(t.status) === TXN_STATUS.OVERDUE;
    }).length;

  updateRow_(SHEETS.STUDENTS, student._row, {
    active_loan_count: Math.max(0, asNumber(student.active_loan_count) - 1),
    overdue_count: overdue
  });
}

function handleAdminConfirmReturn_(payload, session, requestId) {
  // ครูรับคืนแทนนักเรียน (นักเรียนไม่มีมือถือ / รูปถ่ายไม่ผ่าน)
  return processReturn_(payload, session, true);
}

function handleAdminDashboard_(payload, session) {
  var txns = readAll_(SHEETS.TRANSACTIONS);
  var allLines = readAll_(SHEETS.LINES);
  var items = readAll_(SHEETS.ITEMS);

  var linesByTxn = {};
  allLines.forEach(function (l) {
    var t = asString(l.txn_id);
    if (!linesByTxn[t]) linesByTxn[t] = [];
    linesByTxn[t].push(l);
  });

  var outNow = [];
  var overdue = [];
  var pendingRequests = 0;
  var awaitingIssue = 0;

  txns.forEach(function (t) {
    var status = asString(t.status);
    if (status === TXN_STATUS.REQUESTED) { pendingRequests++; return; }
    if (status === TXN_STATUS.APPROVED) { awaitingIssue++; return; }

    if (status === TXN_STATUS.IN_USE || status === TXN_STATUS.PARTIALLY_RETURNED ||
        status === TXN_STATUS.OVERDUE) {
      var entry = serializeTransaction_(t, linesByTxn[asString(t.txn_id)] || []);
      outNow.push(entry);
      if (status === TXN_STATUS.OVERDUE) overdue.push(entry);
    }
  });

  outNow.sort(function (a, b) { return (a.due_at || '').localeCompare(b.due_at || ''); });

  var lowStock = items.filter(function (i) {
    var min = asNumber(i.min_qty);
    return min > 0 && asNumber(i.available_qty) <= min && asString(i.status) === 'ACTIVE';
  }).map(function (i) {
    return {
      item_id: asString(i.item_id), name_th: asString(i.name_th),
      available_qty: asNumber(i.available_qty), min_qty: asNumber(i.min_qty),
      unit: asString(i.unit)
    };
  });

  var pendingStudents = readAll_(SHEETS.STUDENTS).filter(function (s) {
    return asString(s.status) === 'PENDING';
  }).length;

  return {
    out_now: outNow,
    overdue: overdue,
    low_stock: lowStock,
    stats: {
      pending_requests: pendingRequests,
      awaiting_issue: awaitingIssue,
      items_out: outNow.length,
      overdue_count: overdue.length,
      pending_students: pendingStudents,
      total_items: items.length
    }
  };
}

function formatThaiDate_(iso) {
  var d = parseIso(iso);
  if (!d) return '-';
  return Utilities.formatDate(d, TZ, 'd/M/yyyy HH:mm') + ' น.';
}

// ============================================================
// ===== ส่วนที่มาจากไฟล์ Triggers.gs
// ============================================================

/**
 * Triggers.gs — งานอัตโนมัติรายคืน
 *
 * ติดตั้งครั้งเดียวด้วย installTriggers()
 * บัญชีฟรีมีโควต้า trigger 90 นาที/วัน — งานพวกนี้ใช้ไม่กี่วินาที
 */

function installTriggers() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    ScriptApp.deleteTrigger(t);
  });

  ScriptApp.newTrigger('nightlyMaintenance')
    .timeBased().atHour(1).everyDays(1).inTimezone(TZ).create();

  return 'ติดตั้ง trigger เรียบร้อย — ทำงานทุกคืนเวลาประมาณ 01:00 น.';
}

function nightlyMaintenance() {
  var report = [];
  try { report.push('เกินกำหนด: ' + markOverdue_() + ' รายการ'); }
  catch (e) { report.push('markOverdue ล้มเหลว: ' + e); }

  try { report.push('คำขอหมดอายุ: ' + expireStaleRequests_() + ' รายการ'); }
  catch (e) { report.push('expireStaleRequests ล้มเหลว: ' + e); }

  try { report.push('ล้างเซสชัน: ' + cleanupSessions_() + ' รายการ'); }
  catch (e) { report.push('cleanupSessions ล้มเหลว: ' + e); }

  try {
    var rec = reconcileStock_(false);
    report.push('กระทบยอด: พบไม่ตรง ' + rec.mismatches.length + ' รายการ');
    if (rec.mismatches.length) notifyMismatch_(rec.mismatches);
  } catch (e) { report.push('reconcile ล้มเหลว: ' + e); }

  console.log(report.join('\n'));
}

/** ทำเครื่องหมายรายการที่เลยกำหนดคืน + อัปเดตตัวนับของนักเรียน */
function markOverdue_() {
  var txns = readAll_(SHEETS.TRANSACTIONS);
  var updates = [];
  var overdueByStudent = {};

  txns.forEach(function (t) {
    var status = asString(t.status);
    var studentId = asString(t.student_id);

    if (status === TXN_STATUS.IN_USE || status === TXN_STATUS.PARTIALLY_RETURNED) {
      if (isPast(asString(t.due_at))) {
        updates.push({ row: t._row, patch: { status: TXN_STATUS.OVERDUE, updated_at: nowIso() } });
        overdueByStudent[studentId] = (overdueByStudent[studentId] || 0) + 1;
      }
    } else if (status === TXN_STATUS.OVERDUE) {
      overdueByStudent[studentId] = (overdueByStudent[studentId] || 0) + 1;
    }
  });

  updateRowsBatch_(SHEETS.TRANSACTIONS, updates);

  var studentUpdates = [];
  readAll_(SHEETS.STUDENTS).forEach(function (s) {
    var id = asString(s.student_id);
    var count = overdueByStudent[id] || 0;
    if (asNumber(s.overdue_count) !== count) {
      studentUpdates.push({ row: s._row, patch: { overdue_count: count } });
    }
  });
  updateRowsBatch_(SHEETS.STUDENTS, studentUpdates);

  return updates.length;
}

/**
 * ปล่อยการจองของคำขอที่ทิ้งไว้
 * ถ้าไม่มีขั้นตอนนี้ สต็อกจะถูกจองค้างจนแคตตาล็อกเหลือศูนย์
 */
function expireStaleRequests_() {
  var hours = getConfigNum_('request_expiry_hours', 48);
  var cutoff = Date.now() - hours * 3600000;
  var count = 0;

  var stale = readAll_(SHEETS.TRANSACTIONS).filter(function (t) {
    var status = asString(t.status);
    if (status !== TXN_STATUS.REQUESTED && status !== TXN_STATUS.APPROVED) return false;
    var requested = parseIso(asString(t.requested_at));
    return requested && requested.getTime() < cutoff;
  });

  stale.forEach(function (t) {
    try {
      withStockLock_(function () {
        var lines = findRows_(SHEETS.LINES, 'txn_id', asString(t.txn_id));
        releaseReservation_(t, lines, 'SYSTEM', TXN_STATUS.EXPIRED,
          'ไม่มารับอุปกรณ์ภายใน ' + hours + ' ชั่วโมง');
      });
      count++;
    } catch (err) {
      console.warn('expire ' + asString(t.txn_id) + ' ล้มเหลว: ' + err);
    }
  });

  return count;
}

function cleanupSessions_() {
  var sh = sheet_(SHEETS.SESSIONS);
  var sessions = readAll_(SHEETS.SESSIONS);
  var toDelete = [];

  sessions.forEach(function (s) {
    if (asBool(s.revoked) || isPast(asString(s.expires_at))) {
      toDelete.push(s._row);
    }
  });

  // ลบจากล่างขึ้นบน ไม่งั้นเลขแถวเลื่อน
  toDelete.sort(function (a, b) { return b - a; });
  toDelete.forEach(function (row) { sh.deleteRow(row); });

  return toDelete.length;
}

function notifyMismatch_(mismatches) {
  try {
    var email = Session.getEffectiveUser().getEmail();
    if (!email) return;

    var body = 'ระบบ E-Borrow ตรวจพบยอดสต็อกไม่ตรงกัน ' + mismatches.length + ' รายการ\n\n';
    mismatches.slice(0, 20).forEach(function (m) {
      body += '• ' + m.name_th + ' (' + m.item_id + ')\n  ' + m.problems.join('\n  ') + '\n\n';
    });
    body += '\nระบบไม่ได้แก้ไขให้อัตโนมัติ เพื่อไม่ให้ซ่อนสาเหตุที่แท้จริง\n';
    body += 'ตรวจสอบได้ที่หน้าผู้ดูแล > กระทบยอดสต็อก';

    MailApp.sendEmail(email, '[E-Borrow] พบยอดสต็อกไม่ตรง ' + mismatches.length + ' รายการ', body);
  } catch (err) {
    console.warn('แจ้งเตือนทางอีเมลล้มเหลว: ' + err);
  }
}

// ============================================================
// ===== ส่วนที่มาจากไฟล์ Main.gs
// ============================================================

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
