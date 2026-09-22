/**
 * config.js — ค่าตั้งต้นของเว็บ
 *
 * !!! สำคัญที่สุด !!!
 * API_URL คือ URL ของ Apps Script web app
 * เวลาแก้โค้ดฝั่ง Apps Script แล้ว deploy ใหม่ ต้องทำแบบนี้เท่านั้น:
 *   Deploy > Manage deployments > (ดินสอแก้ไข) > Version: New version > Deploy
 * ถ้ากด "New deployment" จะได้ URL ใหม่ และเว็บจะพังทันที
 */

const CONFIG = {
  // URL ของ Apps Script web app (ได้จากการ deploy)
  API_URL: 'https://script.google.com/macros/s/AKfycbxgI6bGrCaTSCf6eaeBQSkwFB-kox6xMf0j7rpV9SfmNb7y1unCj1PptXiD4iRGn-PO7g/exec',

  // path ของเว็บบน GitHub Pages — ตรงกับชื่อ repo
  // ถ้าเปลี่ยนชื่อ repo ต้องแก้ตรงนี้ด้วย
  BASE_PATH: '/e-borrow/',

  // ย่อรูปก่อนอัปโหลด — กล้องมือถือถ่ายได้ 3-8 MB ส่งดิบไม่ได้
  IMAGE: {
    MAX_EDGE: 1280,
    QUALITY_STEPS: [0.7, 0.5, 0.35],
    MAX_BYTES: 1500000
  },

  CATALOG_CACHE_KEY: 'eborrow_catalog',
  CART_KEY: 'eborrow_cart'
};
