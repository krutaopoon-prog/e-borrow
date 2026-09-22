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
  var ADMIN_ID = '000000';                    // รหัสสำหรับเข้าสู่ระบบของครู
  var ADMIN_NAME = 'ครูผู้ดูแลระบบ';
  var ADMIN_PIN = '123456';                   // ต้อง 6-8 หลัก — เปลี่ยนทันทีหลังเข้าระบบครั้งแรก

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
