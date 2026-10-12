-- =============================================================
-- 002_helpers.sql — ฟังก์ชันพื้นฐาน: error, แปลงค่า, เวลา, config, PIN
-- =============================================================

-- ---------- ข้อผิดพลาดที่ตั้งใจให้ผู้ใช้เห็น ----------
-- โยนด้วย MESSAGE = รหัส, DETAIL = ข้อความไทย, HINT = details (json)
-- api() จับแล้วแปลงเป็น {ok:false, error:{code, message_th, details}}

insert into error_messages (code, message_th) values
  ('BAD_REQUEST', 'คำขอไม่ถูกต้อง'),
  ('UNAUTHENTICATED', 'กรุณาเข้าสู่ระบบก่อน'),
  ('SESSION_EXPIRED', 'เซสชันหมดอายุ กรุณาเข้าสู่ระบบใหม่'),
  ('FORBIDDEN', 'คุณไม่มีสิทธิ์ใช้งานส่วนนี้'),
  ('ACCOUNT_PENDING', 'บัญชีของคุณรอครูอนุมัติ'),
  ('ACCOUNT_SUSPENDED', 'บัญชีของคุณถูกระงับ กรุณาติดต่อครู'),
  ('ACCOUNT_LOCKED', 'ใส่รหัสผิดหลายครั้ง บัญชีถูกล็อกชั่วคราว'),
  ('INVALID_CREDENTIALS', 'รหัสนักศึกษาหรือ PIN ไม่ถูกต้อง'),
  ('DUPLICATE_STUDENT_ID', 'รหัสนักศึกษานี้ลงทะเบียนแล้ว'),
  ('WEAK_PIN', 'PIN นี้เดาง่ายเกินไป กรุณาตั้งใหม่'),
  ('NOT_FOUND', 'ไม่พบข้อมูลที่ต้องการ'),
  ('INVALID_STATE', 'ไม่สามารถทำรายการนี้ได้ในสถานะปัจจุบัน'),
  ('INSUFFICIENT_STOCK', 'อุปกรณ์ไม่เพียงพอ'),
  ('LIMIT_EXCEEDED', 'เกินจำนวนที่ยืมได้'),
  ('HAS_OVERDUE', 'คุณมีอุปกรณ์เกินกำหนดคืน กรุณาคืนก่อนยืมใหม่'),
  ('PHOTO_REQUIRED', 'กรุณาถ่ายรูปอุปกรณ์ตอนคืน'),
  ('PHOTO_TOO_LARGE', 'รูปมีขนาดใหญ่เกินไป'),
  ('SYSTEM_BUSY', 'ระบบกำลังยุ่ง กรุณาลองใหม่อีกครั้ง'),
  ('INTERNAL_ERROR', 'เกิดข้อผิดพลาดในระบบ กรุณาแจ้งครู')
on conflict (code) do update set message_th = excluded.message_th;

create or replace function app_error(code text, message_th text default null, details jsonb default null)
returns void language plpgsql as $$
begin
  raise exception using
    errcode = 'P0001',
    message = code,
    detail = coalesce(message_th, (select m.message_th from error_messages m where m.code = app_error.code), 'เกิดข้อผิดพลาด'),
    hint = coalesce(details::text, '');
end $$;

-- ---------- แปลงค่าจาก payload (กันค่าแปลกจาก client) ----------

create or replace function as_int(v text) returns integer
language sql immutable as $$
  select case when v ~ '^\s*-?\d+(\.\d+)?\s*$' then round(v::numeric)::integer else 0 end
$$;

create or replace function as_bool(v text) returns boolean
language sql immutable as $$
  select coalesce(lower(trim(v)) in ('true', 'yes', '1', 'ใช่'), false)
$$;

create or replace function as_text(v text) returns text
language sql immutable as $$
  select coalesce(trim(v), '')
$$;

-- ---------- เวลา: ส่งให้หน้าเว็บเป็น ISO + เวลาไทย เช่น 2026-09-22T14:30:00+07:00 ----------

create or replace function iso(t timestamptz) returns text
language sql stable as $$
  select case when t is null then ''
    else to_char(t at time zone 'Asia/Bangkok', 'YYYY-MM-DD"T"HH24:MI:SS') || '+07:00' end
$$;

/** กำหนดคืน: 0 วัน = สิ้นวันนี้ (จบคาบ) ตามเวลาไทย */
create or replace function due_after_days(days integer) returns timestamptz
language sql stable as $$
  select case when days = 0
    then (date_trunc('day', now() at time zone 'Asia/Bangkok') + interval '23 hours 59 minutes 59 seconds')
         at time zone 'Asia/Bangkok'
    else now() + make_interval(days => days) end
$$;

create or replace function random_token() returns text
language sql volatile set search_path = public, extensions as $$
  select encode(gen_random_bytes(32), 'hex')
$$;

create or replace function sha256_hex(v text) returns text
language sql immutable set search_path = public, extensions as $$
  select encode(digest(v, 'sha256'), 'hex')
$$;

-- ---------- config ----------

create or replace function cfg_text(k text, fallback text default '') returns text
language sql stable as $$
  select coalesce((select nullif(value, '') from config where key = k), fallback)
$$;

create or replace function cfg_int(k text, fallback integer) returns integer
language sql stable as $$
  select coalesce((select case when value ~ '^\s*-?\d+(\.\d+)?\s*$' then round(value::numeric)::integer end
                   from config where key = k), fallback)
$$;

create or replace function cfg_bool(k text, fallback boolean) returns boolean
language sql stable as $$
  select coalesce((select as_bool(value) from config where key = k and value <> ''), fallback)
$$;

create or replace function cfg_json(k text, fallback jsonb) returns jsonb
language plpgsql stable as $$
begin
  return coalesce((select nullif(value, '')::jsonb from config where key = k), fallback);
exception when others then
  return fallback;
end $$;

/** เพิ่มเลขเวอร์ชันแคตตาล็อก — หน้าเว็บรู้ว่าต้องโหลดใหม่ */
create or replace function bump_catalog_version() returns void
language sql as $$
  insert into config (key, value, type, description_th)
  values ('catalog_version', '2', 'number', 'เลขเวอร์ชันแคตตาล็อก (ระบบจัดการเอง)')
  on conflict (key) do update set value = (as_int(config.value) + 1)::text
$$;

-- ---------- PIN ----------
-- PIN 4 หลักมีแค่ 10,000 แบบ จึงป้องกันเป็นชั้น:
--   pepper ใน app_secrets (ไม่ติดไปกับไฟล์ CSV ที่ export) + bcrypt + ล็อกหลังผิด 5 ครั้ง + ห้าม PIN ง่าย

create or replace function pepper() returns text
language plpgsql stable as $$
declare v text;
begin
  select value into v from app_secrets where key = 'PIN_PEPPER';
  if v is null then
    perform app_error('INTERNAL_ERROR', 'ระบบยังไม่ได้ตั้งค่า กรุณาแจ้งครู');
  end if;
  return v;
end $$;

create or replace function hash_pin(pin text) returns text
language sql volatile set search_path = public, extensions as $$
  select crypt(pin || pepper(), gen_salt('bf', 8))
$$;

create or replace function verify_pin(s students, pin text) returns boolean
language sql stable set search_path = public, extensions as $$
  select crypt(pin || pepper(), s.pin_hash) = s.pin_hash
$$;

create or replace function validate_pin_format(pin text, is_admin boolean) returns text
language plpgsql immutable as $$
declare min_len integer := case when is_admin then 6 else 4 end;
begin
  pin := coalesce(trim(pin), '');
  if pin !~ '^\d+$' or length(pin) < min_len or length(pin) > 8 then
    perform app_error('BAD_REQUEST',
      'PIN ต้องเป็นตัวเลข ' || min_len || case when is_admin then '-8' else '' end || ' หลัก');
  end if;
  if not is_admin and pin = any (array[
    '0000','1111','2222','3333','4444','5555','6666','7777','8888','9999',
    '1234','4321','0123','3210','1212','2121','1122','2211',
    '1004','2000','2001','2002','2003','2004','2005','2006','2007','2008',
    '1379','2580','0852','1478','3698','6969','1313','0001','1010','2020']) then
    perform app_error('WEAK_PIN');
  end if;
  if pin ~ '^(\d)\1+$' then
    perform app_error('WEAK_PIN');
  end if;
  return pin;
end $$;
