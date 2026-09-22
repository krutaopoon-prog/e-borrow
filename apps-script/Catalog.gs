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
