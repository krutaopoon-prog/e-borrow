-- =============================================================
-- seed.sql — ค่าตั้งต้น รันหลัง migrations ครบแล้ว (รันซ้ำได้ ไม่ทับค่าที่ครูแก้ไว้)
-- =============================================================

insert into config (key, value, type, description_th) values
  ('app_name', 'E-Borrow ระบบยืม-คืนอุปกรณ์', 'string', 'ชื่อระบบที่แสดงบนหน้าเว็บ'),
  ('default_due_days', '7', 'number', 'จำนวนวันที่ให้ยืมเป็นค่าตั้งต้น (0 = คืนภายในวันนี้)'),
  ('max_active_loans_per_student', '5', 'number', 'จำนวนรายการยืมที่เปิดค้างได้พร้อมกัน'),
  ('max_items_per_request', '10', 'number', 'จำนวนชนิดอุปกรณ์ต่อการยืม 1 ครั้ง'),
  ('block_borrow_if_overdue', 'TRUE', 'boolean', 'ห้ามยืมใหม่ถ้ามีของเกินกำหนดคืน'),
  ('session_ttl_days', '30', 'number', 'จำนวนวันที่ระบบจำการเข้าสู่ระบบ'),
  ('pin_max_attempts', '5', 'number', 'ใส่ PIN ผิดกี่ครั้งแล้วล็อก'),
  ('pin_lockout_minutes', '15', 'number', 'ล็อกนานกี่นาที'),
  ('require_photo_on_return', 'TRUE', 'boolean', 'บังคับถ่ายรูปตอนคืน'),
  ('return_photo_retention_days', '120', 'number', 'เก็บรูปตอนคืนกี่วันแล้วลบอัตโนมัติ (120 ≈ 4 เดือน)'),
  ('audit_retention_days', '365', 'number', 'เก็บประวัติการใช้งาน (AuditLog) กี่วัน'),
  ('auto_approve_requests', 'FALSE', 'boolean', 'อนุมัติคำขออัตโนมัติ (ยังต้องกดจ่ายของอยู่)'),
  ('request_expiry_hours', '48', 'number', 'คำขอที่ไม่มารับเกินกี่ชั่วโมงให้ยกเลิกอัตโนมัติ'),
  ('levels_json', '["ปวช.1","ปวช.2","ปวช.3","ปวส.1","ปวส.2"]', 'json', 'ระดับชั้นในฟอร์มสมัคร'),
  ('departments_json', '["ช่างอิเล็กทรอนิกส์","ช่างไฟฟ้ากำลัง","ช่างยนต์","เทคนิคคอมพิวเตอร์"]', 'json', 'สาขาวิชาในฟอร์มสมัคร'),
  ('announcement', '', 'string', 'ข้อความประกาศบนหน้าแรก (เว้นว่างได้)'),
  ('catalog_version', '1', 'number', 'เลขเวอร์ชันแคตตาล็อก (ระบบจัดการเอง)'),
  ('project_url', '', 'string', 'URL โปรเจกต์ Supabase เช่น https://abcd.supabase.co (ใช้สร้างลิงก์รูป)')
on conflict (key) do nothing;

-- รหัสลับสำหรับเข้ารหัส PIN — สร้างครั้งเดียว ห้ามเปลี่ยนภายหลัง (PIN ทุกคนจะใช้ไม่ได้)
insert into app_secrets (key, value)
values ('PIN_PEPPER', encode(extensions.gen_random_bytes(32), 'hex'))
on conflict (key) do nothing;
