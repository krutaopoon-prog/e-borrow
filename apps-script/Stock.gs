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
