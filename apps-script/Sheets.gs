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
