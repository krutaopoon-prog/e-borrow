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
