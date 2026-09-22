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
