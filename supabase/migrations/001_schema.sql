-- =============================================================
-- 001_schema.sql — ตารางทั้งหมดของ E-Borrow
--
-- รันใน Supabase → SQL Editor ตามลำดับเลขไฟล์ (001, 002, ...)
--
-- หลักความปลอดภัย:
--   ทุกตารางเปิด RLS แต่ "ไม่มี policy" = anon อ่าน/เขียนตรงไม่ได้เลย
--   หน้าเว็บเข้าถึงข้อมูลได้ทางเดียวคือฟังก์ชัน api() (ไฟล์ 008)
--   ซึ่งตรวจ token และสิทธิ์ก่อนทุกครั้ง — เหมือน doPost เดิม
--
-- กฎสต็อก (ต้องจริงเสมอ):
--   ของคืนได้:     available + reserved + out = total
--   ของสิ้นเปลือง:  available + reserved = total   (out = 0)
-- =============================================================

create extension if not exists pgcrypto with schema extensions;

-- ---------- นักเรียนและครู ----------
create table if not exists students (
  student_id        text primary key check (student_id ~ '^[0-9]{4,15}$'),
  full_name         text not null,
  level             text not null default '',
  department        text not null default '',
  section           text not null default '',
  phone             text not null default '',
  pin_hash          text not null,                 -- bcrypt (ไม่ใช่ PIN จริง)
  status            text not null default 'PENDING'
                    check (status in ('PENDING', 'ACTIVE', 'SUSPENDED', 'GRADUATED')),
  role              text not null default 'STUDENT' check (role in ('STUDENT', 'ADMIN')),
  registered_at     timestamptz not null default now(),
  approved_at       timestamptz,
  approved_by       text not null default '',
  failed_pin_count  integer not null default 0,
  locked_until      timestamptz,
  active_loan_count integer not null default 0 check (active_loan_count >= 0),
  overdue_count     integer not null default 0 check (overdue_count >= 0),
  notes             text not null default ''
);
create index if not exists students_status_idx on students (status);

-- ---------- หมวดหมู่และอุปกรณ์ ----------
create table if not exists categories (
  category_id text primary key,
  name_th     text not null,
  name_en     text not null default '',
  icon        text not null default '📦',
  sort_order  integer not null default 99,
  parent_id   text not null default '',
  status      text not null default 'ACTIVE'
);

create table if not exists items (
  item_id          text primary key,
  name_th          text not null,
  name_en          text not null default '',
  category_id      text not null default '',
  description      text not null default '',
  photo_path       text not null default '',     -- path ใน bucket item-photos
  photo_url        text not null default '',
  is_consumable    boolean not null default false,
  unit             text not null default 'ชิ้น',
  total_qty        integer not null default 0,
  available_qty    integer not null default 0,
  reserved_qty     integer not null default 0,
  out_qty          integer not null default 0,
  min_qty          integer not null default 0,
  max_per_borrow   integer not null default 0,
  default_due_days integer,                       -- null = ใช้ค่ากลางจาก config
  storage_location text not null default '',
  status           text not null default 'ACTIVE' check (status in ('ACTIVE', 'HIDDEN', 'RETIRED')),
  tags             text not null default '',
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  -- ด่านสุดท้าย: ถ้าโค้ดมีบั๊กจนยอดติดลบ ฐานข้อมูลจะปฏิเสธทั้งทรานแซกชัน
  constraint items_qty_nonneg check (
    total_qty >= 0 and available_qty >= 0 and reserved_qty >= 0 and out_qty >= 0)
);
create index if not exists items_status_idx on items (status);

-- ---------- การยืม ----------
create table if not exists transactions (
  txn_id                 text primary key,
  student_id             text not null references students (student_id),
  student_name_snapshot  text not null default '',
  status                 text not null,
  requested_at           timestamptz not null default now(),
  approved_at            timestamptz,
  issued_at              timestamptz,
  due_at                 timestamptz,
  returned_at            timestamptz,
  cancelled_at           timestamptz,
  handled_by             text not null default '',
  line_count             integer not null default 0,
  total_qty              integer not null default 0,
  outstanding_qty        integer not null default 0,
  purpose                text not null default '',
  return_photo_path      text not null default '',
  return_photo_url       text not null default '',
  return_photo_deleted_at timestamptz,
  return_note            text not null default '',
  condition_on_return    text not null default '',
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now()
);
create index if not exists transactions_student_idx on transactions (student_id);
create index if not exists transactions_status_idx on transactions (status);

create table if not exists transaction_lines (
  line_id                   text primary key,
  txn_id                    text not null references transactions (txn_id),
  item_id                   text not null,
  item_name_snapshot        text not null default '',
  is_consumable_snapshot    boolean not null default false,
  unit_snapshot             text not null default 'ชิ้น',
  qty_requested             integer not null default 0,
  qty_approved              integer not null default 0,
  qty_issued                integer not null default 0,
  qty_returned              integer not null default 0,
  qty_lost                  integer not null default 0,
  line_due_at               timestamptz,
  line_status               text not null,
  storage_location_snapshot text not null default '',
  note                      text not null default ''
);
create index if not exists transaction_lines_txn_idx on transaction_lines (txn_id);
create index if not exists transaction_lines_item_idx on transaction_lines (item_id);

-- ประวัติทุกการเปลี่ยนแปลงสต็อก — ใช้สืบว่าของหายตอนไหน
create table if not exists stock_ledger (
  ledger_id       bigint generated always as identity primary key,
  "timestamp"     timestamptz not null default now(),
  item_id         text not null,
  txn_id          text not null default '',
  line_id         text not null default '',
  event_type      text not null,
  delta_available integer not null default 0,
  delta_reserved  integer not null default 0,
  delta_out       integer not null default 0,
  delta_total     integer not null default 0,
  available_after integer,
  actor_id        text not null default '',
  reason          text not null default ''
);
create index if not exists stock_ledger_item_idx on stock_ledger (item_id, "timestamp");

-- ---------- ระบบ ----------
create table if not exists sessions (
  token        text primary key,
  student_id   text not null references students (student_id),
  role         text not null,
  issued_at    timestamptz not null default now(),
  expires_at   timestamptz not null,
  last_seen_at timestamptz not null default now(),
  user_agent   text not null default '',
  revoked      boolean not null default false
);
create index if not exists sessions_student_idx on sessions (student_id);

create table if not exists config (
  key            text primary key,
  value          text not null default '',
  type           text not null default 'string',
  description_th text not null default ''
);

create table if not exists audit_log (
  log_id      bigint generated always as identity primary key,
  "timestamp" timestamptz not null default now(),
  actor_id    text not null default '',
  actor_role  text not null default '',
  action      text not null,
  target_type text not null default '',
  target_id   text not null default '',
  detail_json text not null default '',
  result      text not null
);
create index if not exists audit_log_time_idx on audit_log ("timestamp");

-- กันส่งซ้ำ: requestId เดิม → คืนคำตอบเดิม ไม่สร้างรายการยืมใบที่สอง
create table if not exists idempotency (
  request_id text primary key,
  response   jsonb not null,
  created_at timestamptz not null default now()
);

-- เลขรายการยืมรายวัน TXN-YYYYMMDD-0001 (นับแบบ atomic ไม่ต้องอ่านทั้งตาราง)
create table if not exists daily_counters (
  day date primary key,
  n   integer not null
);

-- การคืนที่เริ่มแล้วแต่ยังไม่ยืนยัน (แทน CacheService เดิม)
create table if not exists pending_returns (
  return_id    text primary key,
  upload_token text not null unique,
  txn_id       text not null,
  student_id   text not null,
  actor_id     text not null,
  lines        jsonb not null,
  created_at   timestamptz not null default now(),
  finalized_at timestamptz
);

-- ตั๋วอัปโหลดรูปใช้ครั้งเดียว — storage policy อนุญาตเฉพาะ path ที่ขึ้นต้นด้วย ticket
create table if not exists upload_tickets (
  ticket     text primary key,
  bucket     text not null,
  purpose    text not null,
  ref_id     text not null,
  created_by text not null,
  expires_at timestamptz not null,
  used       boolean not null default false
);

-- ไฟล์ที่รอลบออกจาก Storage (Edge Function storage-cleanup มาเก็บไปลบ)
create table if not exists storage_delete_queue (
  id        bigint generated always as identity primary key,
  bucket    text not null,
  path      text not null,
  reason    text not null default '',
  queued_at timestamptz not null default now()
);

-- ผลกระทบยอดสต็อกรายคืน — แสดงเป็นแถบเตือนบนแดชบอร์ดครู
create table if not exists reconcile_reports (
  id         bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  mismatches jsonb not null
);

-- ความลับของระบบ เช่น PIN_PEPPER — ห้ามมีใครอ่านได้นอกจากฟังก์ชัน
create table if not exists app_secrets (
  key   text primary key,
  value text not null
);

create table if not exists error_messages (
  code       text primary key,
  message_th text not null
);

-- ---------- ปิดตายทุกตาราง ----------
do $$
declare t text;
begin
  foreach t in array array[
    'students', 'categories', 'items', 'transactions', 'transaction_lines',
    'stock_ledger', 'sessions', 'config', 'audit_log', 'idempotency',
    'daily_counters', 'pending_returns', 'upload_tickets', 'storage_delete_queue',
    'reconcile_reports', 'app_secrets', 'error_messages']
  loop
    execute format('alter table %I enable row level security', t);
    execute format('revoke all on table %I from anon, authenticated', t);
  end loop;
end $$;
