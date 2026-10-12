-- =============================================================
-- 005_borrow.sql — ยืม: ตะกร้า → คำขอ → ครูอนุมัติ → ครูจ่ายของ
--
-- สถานะ: REQUESTED → APPROVED → IN_USE / CLOSED_CONSUMED
--         └→ REJECTED / CANCELLED / EXPIRED (คืนการจอง)
--
-- ลำดับการล็อกทุกที่: items → transactions → students (กัน deadlock)
-- =============================================================

create or replace function open_statuses() returns text[]
language sql immutable as $$
  select array['REQUESTED', 'APPROVED', 'IN_USE', 'PARTIALLY_RETURNED', 'OVERDUE']
$$;

/** TXN-YYYYMMDD-0001 — นับแบบ atomic ต่อวัน (เวลาไทย) */
create or replace function next_txn_id() returns text
language plpgsql as $$
declare
  d date := (now() at time zone 'Asia/Bangkok')::date;
  n integer;
begin
  insert into daily_counters (day, n) values (d, 1)
  on conflict (day) do update set n = daily_counters.n + 1
  returning daily_counters.n into n;
  return 'TXN-' || to_char(d, 'YYYYMMDD') || '-' || lpad(n::text, 4, '0');
end $$;

create or replace function serialize_txn(t transactions) returns jsonb
language sql stable as $$
  select jsonb_build_object(
    'txn_id', t.txn_id,
    'student_id', t.student_id,
    'student_name', t.student_name_snapshot,
    'status', t.status,
    'requested_at', iso(t.requested_at),
    'approved_at', iso(t.approved_at),
    'issued_at', iso(t.issued_at),
    'due_at', iso(t.due_at),
    'returned_at', iso(t.returned_at),
    'line_count', t.line_count,
    'total_qty', t.total_qty,
    'outstanding_qty', t.outstanding_qty,
    'purpose', t.purpose,
    'return_photo_url', t.return_photo_url,
    'return_photo_deleted', t.return_photo_deleted_at is not null,
    'return_note', t.return_note,
    'condition_on_return', t.condition_on_return,
    'is_overdue', t.status = 'OVERDUE',
    'lines', coalesce((
      select jsonb_agg(jsonb_build_object(
        'line_id', l.line_id,
        'item_id', l.item_id,
        'item_name', l.item_name_snapshot,
        'is_consumable', l.is_consumable_snapshot,
        'unit', l.unit_snapshot,
        'qty_requested', l.qty_requested,
        'qty_approved', l.qty_approved,
        'qty_issued', l.qty_issued,
        'qty_returned', l.qty_returned,
        'qty_lost', l.qty_lost,
        'outstanding', l.qty_issued - l.qty_returned - l.qty_lost,
        'line_due_at', iso(l.line_due_at),
        'line_status', l.line_status,
        'note', l.note) order by length(l.line_id), l.line_id)
      from transaction_lines l where l.txn_id = t.txn_id), '[]'::jsonb))
$$;

/** โหลดรายการยืม — ถ้า p_lock จะล็อกอุปกรณ์ทุกชิ้นในรายการ แล้วล็อกตัวรายการ */
create or replace function load_txn(p_txn text, p_lock boolean default false) returns transactions
language plpgsql as $$
declare t transactions;
begin
  if p_lock then
    perform lock_items(array(select item_id from transaction_lines where txn_id = p_txn));
    select * into t from transactions where txn_id = p_txn for update;
  else
    select * into t from transactions where txn_id = p_txn;
  end if;
  if not found then perform app_error('NOT_FOUND', 'ไม่พบรายการยืมนี้'); end if;
  return t;
end $$;

-- ---------- ตะกร้า ----------

/** ตรวจตะกร้าก่อนกดยืม — แค่บอกล่วงหน้า ไม่ใช่การรับประกัน */
create or replace function h_validate_cart(p jsonb, sess jsonb) returns jsonb
language plpgsql as $$
declare
  l jsonb;
  it items;
  qty integer;
  issues jsonb := '[]'::jsonb;
begin
  if jsonb_array_length(coalesce(p->'lines', '[]'::jsonb)) = 0 then
    return jsonb_build_object('valid', false,
      'issues', jsonb_build_array(jsonb_build_object('code', 'EMPTY_CART', 'message_th', 'ตะกร้าว่าง')));
  end if;

  for l in select * from jsonb_array_elements(p->'lines') loop
    qty := as_int(l->>'qty');
    select * into it from items where item_id = as_text(l->>'item_id');
    if not found then
      issues := issues || jsonb_build_object('item_id', l->>'item_id', 'code', 'NOT_FOUND',
                                             'message_th', 'ไม่พบอุปกรณ์');
      continue;
    end if;
    if it.status <> 'ACTIVE' then
      issues := issues || jsonb_build_object('item_id', it.item_id, 'code', 'INVALID_STATE',
                                             'message_th', it.name_th || ' ไม่เปิดให้ยืม');
      continue;
    end if;
    if qty > it.available_qty then
      issues := issues || jsonb_build_object('item_id', it.item_id, 'code', 'INSUFFICIENT_STOCK',
        'available', it.available_qty,
        'message_th', it.name_th || ' เหลือ ' || it.available_qty || ' ' || it.unit);
    end if;
    if it.max_per_borrow > 0 and qty > it.max_per_borrow then
      issues := issues || jsonb_build_object('item_id', it.item_id, 'code', 'LIMIT_EXCEEDED',
        'message_th', it.name_th || ' ยืมได้ครั้งละไม่เกิน ' || it.max_per_borrow);
    end if;
  end loop;

  return jsonb_build_object('valid', jsonb_array_length(issues) = 0, 'issues', issues);
end $$;

-- ---------- ส่งคำขอยืม ----------

create or replace function h_submit_request(p jsonb, sess jsonb) returns jsonb
language plpgsql as $$
declare
  v_sid     text := sess->>'student_id';
  lines     jsonb := coalesce(p->'lines', '[]'::jsonb);
  merged    record;
  s         students;
  it        items;
  v_txn     text;
  auto      boolean := cfg_bool('auto_approve_requests', false);
  def_due   integer := cfg_int('default_due_days', 7);
  max_loans integer := cfg_int('max_active_loans_per_student', 5);
  max_items integer := cfg_int('max_items_per_request', 10);
  line_due  timestamptz;
  max_due   timestamptz;
  total_q   integer := 0;
  outst_q   integer := 0;
  idx       integer := 0;
  ids       text[];
begin
  if jsonb_array_length(lines) = 0 then perform app_error('BAD_REQUEST', 'ตะกร้าว่าง'); end if;
  if jsonb_array_length(lines) > max_items then
    perform app_error('LIMIT_EXCEEDED', 'ยืมได้ครั้งละไม่เกิน ' || max_items || ' ชนิด');
  end if;
  if exists (select 1 from jsonb_array_elements(lines) e where as_text(e->>'item_id') = '') then
    perform app_error('BAD_REQUEST', 'ข้อมูลอุปกรณ์ไม่ครบ');
  end if;

  -- รวมบรรทัดซ้ำ (นักเรียนกดเพิ่มอุปกรณ์เดิมสองครั้ง) แล้วล็อกตามลำดับ item_id
  ids := array(select distinct as_text(e->>'item_id') from jsonb_array_elements(lines) e);
  perform lock_items(ids);
  s := get_student(v_sid, true);

  -- กันยืมเพิ่มถ้ามีของค้างเกินกำหนด
  if cfg_bool('block_borrow_if_overdue', true) and s.overdue_count > 0 then
    perform app_error('HAS_OVERDUE');
  end if;
  if s.active_loan_count >= max_loans then
    perform app_error('LIMIT_EXCEEDED',
      'คุณมีรายการยืมค้างอยู่ ' || s.active_loan_count || ' รายการแล้ว (สูงสุด ' || max_loans || ')');
  end if;

  v_txn := next_txn_id();
  insert into transactions (txn_id, student_id, student_name_snapshot, status, purpose)
  values (v_txn, v_sid, s.full_name, case when auto then 'APPROVED' else 'REQUESTED' end,
          left(as_text(p->>'purpose'), 200));

  for merged in
    select as_text(e->>'item_id') as item_id, sum(as_int(e->>'qty'))::integer as qty,
           min(ord) as first_ord
    from jsonb_array_elements(lines) with ordinality as x(e, ord)
    group by 1 order by first_ord
  loop
    idx := idx + 1;
    it := stock_reserve(merged.item_id, merged.qty, v_sid, v_txn);

    line_due := due_after_days(coalesce(it.default_due_days, def_due));
    if max_due is null or line_due > max_due then max_due := line_due; end if;
    total_q := total_q + merged.qty;
    if not it.is_consumable then outst_q := outst_q + merged.qty; end if;

    insert into transaction_lines (line_id, txn_id, item_id, item_name_snapshot,
      is_consumable_snapshot, unit_snapshot, qty_requested, qty_approved, line_due_at,
      line_status, storage_location_snapshot)
    values (v_txn || '-L' || idx, v_txn, it.item_id, it.name_th, it.is_consumable,
      coalesce(nullif(it.unit, ''), 'ชิ้น'), merged.qty, merged.qty, line_due,
      case when auto then 'APPROVED' else 'PENDING' end, it.storage_location);
  end loop;

  update transactions set due_at = max_due, line_count = idx, total_qty = total_q,
    outstanding_qty = outst_q, approved_at = case when auto then now() end
  where txn_id = v_txn;

  update students set active_loan_count = active_loan_count + 1 where student_id = v_sid;
  perform bump_catalog_version();

  return jsonb_build_object(
    'txn_id', v_txn,
    'status', case when auto then 'APPROVED' else 'REQUESTED' end,
    'due_preview', iso(max_due),
    'message_th', case when auto then 'ส่งคำขอแล้ว กรุณาไปรับอุปกรณ์จากครู'
                       else 'ส่งคำขอแล้ว รอครูอนุมัติ' end);
end $$;

-- ---------- ยกเลิก / ปฏิเสธ / หมดอายุ ----------

/** คืนการจองและปิดรายการ — ต้องเรียกหลัง load_txn(..., true) แล้ว */
create or replace function release_reservation(t transactions, actor text, new_status text, reason text)
returns void language plpgsql as $$
declare l transaction_lines;
begin
  for l in select * from transaction_lines where txn_id = t.txn_id and line_status <> 'CANCELLED' loop
    perform stock_unreserve(l.item_id, coalesce(nullif(l.qty_approved, 0), l.qty_requested),
                            actor, t.txn_id, l.line_id, reason);
  end loop;
  update transaction_lines set line_status = 'CANCELLED' where txn_id = t.txn_id;
  update transactions set status = new_status, updated_at = now(), cancelled_at = now(),
    return_note = coalesce(nullif(reason, ''), return_note)
  where txn_id = t.txn_id;
  update students set active_loan_count = greatest(0, active_loan_count - 1)
  where student_id = t.student_id;
  perform bump_catalog_version();
end $$;

create or replace function h_cancel_request(p jsonb, sess jsonb) returns jsonb
language plpgsql as $$
declare t transactions := load_txn(as_text(p->>'txn_id'), true);
begin
  -- txn_id เดาได้ ต้องเช็กความเป็นเจ้าของเสมอ
  if t.student_id <> sess->>'student_id' and sess->>'role' <> 'ADMIN' then
    perform app_error('FORBIDDEN');
  end if;
  if t.status not in ('REQUESTED', 'APPROVED') then
    perform app_error('INVALID_STATE', 'ยกเลิกได้เฉพาะรายการที่ยังไม่ได้รับของ');
  end if;
  perform release_reservation(t, sess->>'student_id', 'CANCELLED', 'นักเรียนยกเลิก');
  return jsonb_build_object('txn_id', t.txn_id, 'status', 'CANCELLED');
end $$;

-- ---------- ดูรายการ ----------

create or replace function h_my_transactions(p jsonb, sess jsonb) returns jsonb
language sql stable as $$
  with mine as (
    select t from transactions t where t.student_id = sess->>'student_id'
  ), f as (
    select t from mine
    where case coalesce(p->>'status_filter', '')
      when '' then true
      when 'open' then (t).status = any (open_statuses())
      when 'closed' then not ((t).status = any (open_statuses()))
      else (t).status = p->>'status_filter' end
  )
  select jsonb_build_object(
    'transactions', coalesce((select jsonb_agg(serialize_txn(t) order by (t).requested_at desc) from f), '[]'::jsonb),
    'summary', jsonb_build_object(
      'active', (select count(*) from mine where (t).status = any (open_statuses())),
      'overdue', (select count(*) from mine where (t).status = 'OVERDUE')))
$$;

create or replace function h_get_transaction(p jsonb, sess jsonb) returns jsonb
language plpgsql as $$
declare t transactions := load_txn(as_text(p->>'txn_id'));
begin
  if t.student_id <> sess->>'student_id' and sess->>'role' <> 'ADMIN' then
    perform app_error('FORBIDDEN');
  end if;
  return jsonb_build_object('transaction', serialize_txn(t));
end $$;
