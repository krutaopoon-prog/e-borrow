-- =============================================================
-- 011_permissions.sql — สิทธิ์เรียกฟังก์ชัน (รันเป็นไฟล์สุดท้ายเสมอ)
--
-- หน้าเว็บ (anon) เรียกได้แค่ 2 ฟังก์ชัน:
--   api()               ทางเข้าเดียวของทุกคำสั่ง
--   storage_ticket_ok() ใช้ใน policy ตอนอัปรูป
-- ฟังก์ชันอื่นทั้งหมดเรียกตรงไม่ได้ (เช่น create_admin, nightly_maintenance)
--
-- ⚠ ทุกครั้งที่แก้หรือเพิ่มฟังก์ชันใน SQL Editor ให้รันไฟล์นี้ซ้ำ
-- =============================================================

revoke execute on all functions in schema public from public, anon, authenticated;
alter default privileges in schema public revoke execute on functions from public, anon, authenticated;

grant execute on function api(text, text, jsonb, text) to anon, authenticated;
grant execute on function storage_ticket_ok(text, text) to anon, authenticated;
