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
