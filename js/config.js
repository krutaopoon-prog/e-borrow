/**
 * config.js — ค่าตั้งต้นของเว็บ
 *
 * !!! สำคัญที่สุด !!!
 * SUPABASE_URL และ SUPABASE_ANON_KEY ได้จาก
 *   Supabase Dashboard → Project Settings → API
 * anon key เปิดเผยในหน้าเว็บได้ (ออกแบบมาให้อยู่ฝั่ง client) — ห้ามใส่ service_role key เด็ดขาด
 */

const CONFIG = {
  SUPABASE_URL: 'https://umercgyehpbjeqxrtjzz.supabase.co',
  SUPABASE_ANON_KEY: 'sb_publishable_xqgJP-7HN0-CtpcntsutvQ_qn32D_2L',

  // path ของเว็บบน GitHub Pages — ตรงกับชื่อ repo
  // ถ้าเปลี่ยนชื่อ repo ต้องแก้ตรงนี้ด้วย
  BASE_PATH: '/e-borrow/',

  // ย่อรูปก่อนอัปโหลด — Supabase ฟรีมีพื้นที่ 1 GB ต้องประหยัด
  // ด้านยาว 800px WebP คุณภาพ 0.6 ได้ ~40-60 KB ยังเห็นสภาพอุปกรณ์ชัด
  IMAGE: {
    MAX_EDGE: 800,          // รูปตอนคืน
    ITEM_MAX_EDGE: 600,     // รูปอุปกรณ์ในแคตตาล็อก
    QUALITY_STEPS: [0.6, 0.45, 0.3],
    MAX_BYTES: 150000
  },

  CATALOG_CACHE_KEY: 'eborrow_catalog',
  CART_KEY: 'eborrow_cart'
};
