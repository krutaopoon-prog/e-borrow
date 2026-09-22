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
