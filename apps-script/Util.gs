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
