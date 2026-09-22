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
