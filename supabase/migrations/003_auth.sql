-- =============================================================
-- 003_auth.sql — สมัคร เข้าสู่ระบบ เซสชัน ตรวจสิทธิ์
--
-- token ที่ส่งให้หน้าเว็บเก็บในตารางแบบ hash (sha256)
-- ถ้าข้อมูลในฐานหลุด ก็เอา token ไปสวมรอยไม่ได้
-- =============================================================

create or replace function audit(actor_id text, actor_role text, action text, result text, detail jsonb)
returns void language plpgsql as $$
declare d text := '';
begin
  if detail is not null then
    d := detail::text;
    -- ห้ามบันทึก PIN และรูปลง log
    d := regexp_replace(d, '"(pin|old_pin|new_pin)": "[^"]*"', '"\1": "***"', 'g');
    if length(d) > 500 then d := left(d, 500) || '...'; end if;
  end if;
  insert into audit_log (actor_id, actor_role, action, detail_json, result)
  values (coalesce(actor_id, ''), coalesce(actor_role, ''), action, d, result);
end $$;

-- ---------- สมัคร ----------

create or replace function h_register(p jsonb) returns jsonb
language plpgsql as $$
declare
  v_id   text := as_text(p->>'student_id');
  v_name text := as_text(p->>'full_name');
  v_lvl  text := as_text(p->>'level');
  v_dept text := as_text(p->>'department');
  v_pin  text;
begin
  if v_id = '' or v_name = '' or v_lvl = '' or v_dept = '' then
    perform app_error('BAD_REQUEST', 'กรุณากรอกข้อมูลให้ครบ');
  end if;
  if v_id !~ '^[0-9]{4,15}$' then
    perform app_error('BAD_REQUEST', 'รหัสนักศึกษาต้องเป็นตัวเลข 4-15 หลัก');
  end if;
  if length(v_name) > 100 then
    perform app_error('BAD_REQUEST', 'ชื่อยาวเกินไป');
  end if;
  v_pin := validate_pin_format(p->>'pin', false);

  insert into students (student_id, full_name, level, department, section, phone, pin_hash, status, role)
  values (v_id, v_name, v_lvl, v_dept, as_text(p->>'section'), as_text(p->>'phone'),
          hash_pin(v_pin), 'PENDING', 'STUDENT')
  on conflict (student_id) do nothing;
  if not found then
    perform app_error('DUPLICATE_STUDENT_ID');
  end if;

  return jsonb_build_object(
    'status', 'PENDING',
    'message_th', 'สมัครเรียบร้อยแล้ว กรุณารอครูอนุมัติก่อนเข้าใช้งาน');
end $$;

-- ---------- เข้าสู่ระบบ ----------
-- ใส่ PIN ผิดต้อง "บันทึกการนับ" ก่อนตอบ error จึงคืน {__error} แทนการ raise
-- (raise จะ rollback การนับทิ้ง แล้วการล็อกบัญชีจะไม่เคยทำงาน)

create or replace function h_login(p jsonb) returns jsonb
language plpgsql as $$
declare
  v_id  text := as_text(p->>'student_id');
  v_pin text := as_text(p->>'pin');
  s     students;
  fails integer;
  token text;
  ttl   integer;
begin
  if v_id = '' or v_pin = '' then perform app_error('INVALID_CREDENTIALS'); end if;

  select * into s from students where student_id = v_id for update;
  -- ไม่บอกว่ารหัสนักศึกษามีจริงหรือไม่ (กันการไล่เดารายชื่อ)
  if not found then perform app_error('INVALID_CREDENTIALS'); end if;

  if s.locked_until is not null and s.locked_until > now() then
    perform app_error('ACCOUNT_LOCKED');
  end if;

  if not verify_pin(s, v_pin) then
    fails := s.failed_pin_count + 1;
    if fails >= cfg_int('pin_max_attempts', 5) then
      update students set failed_pin_count = 0,
        locked_until = now() + make_interval(mins => cfg_int('pin_lockout_minutes', 15))
      where student_id = v_id;
    else
      update students set failed_pin_count = fails where student_id = v_id;
    end if;
    return jsonb_build_object('__error', 'INVALID_CREDENTIALS');
  end if;

  -- ตรวจสถานะ "หลัง" PIN ถูก — ไม่งั้นระบบบอกว่าบัญชีไหนมีจริง
  if s.status = 'PENDING' then perform app_error('ACCOUNT_PENDING'); end if;
  if s.status = 'SUSPENDED' then perform app_error('ACCOUNT_SUSPENDED'); end if;
  if s.status = 'GRADUATED' then perform app_error('ACCOUNT_SUSPENDED', 'บัญชีนี้ปิดการใช้งานแล้ว'); end if;

  if s.failed_pin_count > 0 or s.locked_until is not null then
    update students set failed_pin_count = 0, locked_until = null where student_id = v_id;
  end if;

  token := random_token();
  ttl := cfg_int('session_ttl_days', 30);
  insert into sessions (token, student_id, role, expires_at, user_agent)
  values (sha256_hex(token), s.student_id, s.role, now() + make_interval(days => ttl),
          left(as_text(p->>'user_agent'), 120));

  return jsonb_build_object(
    'token', token,
    'expires_at', iso(now() + make_interval(days => ttl)),
    'student', jsonb_build_object(
      'student_id', s.student_id, 'full_name', s.full_name, 'level', s.level,
      'department', s.department, 'role', s.role));
end $$;

-- ---------- ตรวจ token (ทุก request ที่ต้องล็อกอิน) ----------

create or replace function require_auth(token text) returns jsonb
language plpgsql as $$
declare
  h text;
  r sessions;
begin
  if coalesce(token, '') = '' then perform app_error('UNAUTHENTICATED'); end if;
  h := sha256_hex(token);

  select * into r from sessions where sessions.token = h;
  if not found or r.revoked or r.expires_at < now() then
    perform app_error('SESSION_EXPIRED');
  end if;

  -- อัปเดต last_seen แบบขี้เกียจ ชั่วโมงละครั้ง
  if r.last_seen_at < now() - interval '1 hour' then
    update sessions set last_seen_at = now() where sessions.token = h;
  end if;

  return jsonb_build_object(
    'token_hash', h, 'student_id', r.student_id,
    'role', r.role,   -- อ่านจากฐานข้อมูลเท่านั้น ห้ามเชื่อ payload
    'expires_at', iso(r.expires_at));
end $$;

create or replace function get_student(v_id text, p_lock boolean default false) returns students
language plpgsql as $$
declare s students;
begin
  if p_lock then
    select * into s from students where student_id = v_id for update;
  else
    select * into s from students where student_id = v_id;
  end if;
  if not found then perform app_error('NOT_FOUND', 'ไม่พบข้อมูลนักเรียน'); end if;
  return s;
end $$;

create or replace function h_validate_session(p jsonb, sess jsonb) returns jsonb
language plpgsql as $$
declare s students := get_student(sess->>'student_id');
begin
  return jsonb_build_object(
    'valid', true,
    'expires_at', sess->>'expires_at',
    'student', jsonb_build_object(
      'student_id', s.student_id, 'full_name', s.full_name, 'level', s.level,
      'department', s.department, 'role', s.role,
      'active_loan_count', s.active_loan_count, 'overdue_count', s.overdue_count));
end $$;

create or replace function h_logout(p jsonb, sess jsonb) returns jsonb
language sql as $$
  update sessions set revoked = true where token = sess->>'token_hash';
  select jsonb_build_object('ok', true);
$$;

/** ยกเลิกทุก session ของคนนี้ ยกเว้นอันปัจจุบัน (keep_hash) */
create or replace function revoke_all_sessions(v_id text, keep_hash text) returns void
language sql as $$
  update sessions set revoked = true
  where student_id = v_id and not revoked and token is distinct from keep_hash;
$$;

create or replace function h_change_pin(p jsonb, sess jsonb) returns jsonb
language plpgsql as $$
declare
  s students := get_student(sess->>'student_id', true);
  v_new text;
begin
  if not verify_pin(s, as_text(p->>'old_pin')) then
    perform app_error('INVALID_CREDENTIALS', 'PIN เดิมไม่ถูกต้อง');
  end if;
  v_new := validate_pin_format(p->>'new_pin', sess->>'role' = 'ADMIN');

  update students set pin_hash = hash_pin(v_new)
  where student_id = s.student_id;

  perform revoke_all_sessions(s.student_id, sess->>'token_hash');
  return jsonb_build_object('ok', true, 'message_th', 'เปลี่ยน PIN เรียบร้อย');
end $$;

-- ---------- รันเองจาก SQL Editor ----------

/**
 * สร้างบัญชีครู — รันครั้งเดียว:
 *   select create_admin('000000', 'ครูผู้ดูแลระบบ', '123456');
 * แล้วเข้าระบบไปเปลี่ยน PIN ทันที
 */
create or replace function create_admin(v_id text, v_name text, v_pin text) returns text
language plpgsql as $$
begin
  if exists (select 1 from students where student_id = v_id) then
    return 'มีบัญชีนี้อยู่แล้ว: ' || v_id;
  end if;
  v_pin := validate_pin_format(v_pin, true);
  insert into students (student_id, full_name, level, department, pin_hash, status, role,
                        approved_at, approved_by)
  values (v_id, v_name, '-', '-', hash_pin(v_pin), 'ACTIVE', 'ADMIN', now(), 'SYSTEM');
  return 'สร้างบัญชีครูเรียบร้อย: ' || v_id || ' — เปลี่ยน PIN ทันทีหลังเข้าระบบ';
end $$;

/**
 * ตั้ง PIN ใหม่ให้ใครก็ได้ (เช่นครูลืม PIN ตัวเอง):
 *   select reset_pin_for_user('000000', '654321');
 */
create or replace function reset_pin_for_user(v_id text, v_pin text) returns text
language plpgsql as $$
declare s students;
begin
  select * into s from students where student_id = v_id;
  if not found then return 'ไม่พบรหัส ' || v_id || ' ในระบบ'; end if;
  v_pin := validate_pin_format(v_pin, s.role = 'ADMIN');
  update students set pin_hash = hash_pin(v_pin),
    failed_pin_count = 0, locked_until = null
  where student_id = v_id;
  perform revoke_all_sessions(v_id, null);
  return 'ตั้ง PIN ใหม่ให้ ' || v_id || ' (' || s.full_name || ') เรียบร้อย — เข้าระบบได้เลย';
end $$;
