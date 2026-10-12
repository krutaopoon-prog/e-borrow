-- =============================================================
-- 007_admin.sql — แคตตาล็อก, ค่าตั้งค่า, งานของครู
-- =============================================================

-- ---------- แคตตาล็อก ----------
-- คืนทั้งก้อนครั้งเดียว ให้หน้าเว็บค้นหา/กรองเอง

create or replace function catalog_item(i items, is_admin boolean) returns jsonb
language sql stable as $$
  select jsonb_build_object(
    'item_id', i.item_id, 'name_th', i.name_th, 'name_en', i.name_en,
    'category_id', i.category_id, 'description', i.description, 'photo_url', i.photo_url,
    'is_consumable', i.is_consumable, 'unit', coalesce(nullif(i.unit, ''), 'ชิ้น'),
    'available_qty', i.available_qty, 'total_qty', i.total_qty,
    'max_per_borrow', i.max_per_borrow, 'default_due_days', i.default_due_days,
    'tags', i.tags)
  -- ตำแหน่งตู้และขั้นต่ำเป็นข้อมูลของครู — ไม่ส่งให้นักเรียน
  || case when is_admin then jsonb_build_object(
       'storage_location', i.storage_location, 'min_qty', i.min_qty,
       'reserved_qty', i.reserved_qty, 'out_qty', i.out_qty, 'status', i.status)
     else '{}'::jsonb end
$$;

create or replace function h_get_catalog(p jsonb, sess jsonb) returns jsonb
language sql stable as $$
  select jsonb_build_object(
    'categories', coalesce((
      select jsonb_agg(jsonb_build_object(
        'category_id', c.category_id, 'name_th', c.name_th, 'name_en', c.name_en,
        'icon', c.icon, 'sort_order', c.sort_order) order by c.sort_order, c.category_id)
      from categories c where c.status <> 'HIDDEN'), '[]'::jsonb),
    'items', coalesce((
      select jsonb_agg(catalog_item(i, coalesce(sess->>'role', '') = 'ADMIN') order by i.item_id)
      from items i where i.status = 'ACTIVE'), '[]'::jsonb),
    'version', cfg_int('catalog_version', 1),
    'config', jsonb_build_object(
      'max_items_per_request', cfg_int('max_items_per_request', 10),
      'default_due_days', cfg_int('default_due_days', 7),
      'require_photo_on_return', cfg_bool('require_photo_on_return', true)))
$$;

/** สำรองไว้ตอนแคตตาล็อกใหญ่เกินส่งทีเดียว */
create or replace function h_list_items(p jsonb, sess jsonb) returns jsonb
language plpgsql stable as $$
declare
  q     text := lower(as_text(p->>'q'));
  cat   text := as_text(p->>'category_id');
  avail boolean := as_bool(p->>'only_available');
  pg    integer := greatest(1, as_int(p->>'page'));
  sz    integer := least(100, coalesce(nullif(as_int(p->>'page_size'), 0), 24));
  res   jsonb;
  total integer;
begin
  with f as (
    select i from items i
    where i.status = 'ACTIVE'
      and (cat = '' or i.category_id = cat)
      and (not avail or i.available_qty > 0)
      and (q = '' or strpos(lower(i.name_th || ' ' || i.name_en || ' ' || i.tags), q) > 0)
  )
  select count(*), coalesce((
    select jsonb_agg(catalog_item(x.i, false) order by (x.i).item_id)
    from (select i from f order by (i).item_id offset (pg - 1) * sz limit sz) x), '[]'::jsonb)
  into total, res from f;
  return jsonb_build_object('items', res, 'total', total, 'page', pg);
end $$;

create or replace function h_get_item(p jsonb, sess jsonb) returns jsonb
language plpgsql stable as $$
declare i items;
begin
  select * into i from items where item_id = as_text(p->>'item_id');
  if not found or i.status = 'RETIRED' then perform app_error('NOT_FOUND', 'ไม่พบอุปกรณ์นี้'); end if;
  return jsonb_build_object('item', catalog_item(i, coalesce(sess->>'role', '') = 'ADMIN'));
end $$;

create or replace function h_admin_upsert_item(p jsonb, sess jsonb) returns jsonb
language plpgsql as $$
declare
  input jsonb := coalesce(p->'item', '{}'::jsonb);
  v_id  text := as_text(input->>'item_id');
  v_name text := as_text(input->>'name_th');
  it    items;
  diff  integer;
  total integer;
  n     integer;
begin
  if v_name = '' then perform app_error('BAD_REQUEST', 'ต้องระบุชื่ออุปกรณ์'); end if;

  if v_id <> '' then
    select * into it from items where item_id = v_id for update;
  end if;

  if it.item_id is not null then
    -- แก้ total_qty ต้องปรับ available ตามด้วย ไม่งั้นยอดรวมเพี้ยน
    diff := 0;
    if input ? 'total_qty' then
      diff := as_int(input->>'total_qty') - it.total_qty;
      if it.available_qty + diff < 0 then
        perform app_error('BAD_REQUEST',
          'ลดจำนวนไม่ได้ เพราะมีของถูกยืมออกไปอยู่ ' || it.out_qty || ' ชิ้น');
      end if;
    end if;

    update items set
      name_th          = v_name,
      name_en          = case when input ? 'name_en' then as_text(input->>'name_en') else name_en end,
      category_id      = case when input ? 'category_id' then as_text(input->>'category_id') else category_id end,
      description      = case when input ? 'description' then as_text(input->>'description') else description end,
      unit             = case when input ? 'unit' then coalesce(nullif(as_text(input->>'unit'), ''), 'ชิ้น') else unit end,
      storage_location = case when input ? 'storage_location' then as_text(input->>'storage_location') else storage_location end,
      status           = case when input ? 'status' and as_text(input->>'status') <> '' then as_text(input->>'status') else status end,
      tags             = case when input ? 'tags' then as_text(input->>'tags') else tags end,
      min_qty          = case when input ? 'min_qty' then as_int(input->>'min_qty') else min_qty end,
      max_per_borrow   = case when input ? 'max_per_borrow' then as_int(input->>'max_per_borrow') else max_per_borrow end,
      default_due_days = case when input ? 'default_due_days'
                              then case when as_text(input->>'default_due_days') = '' then null
                                        else as_int(input->>'default_due_days') end
                              else default_due_days end,
      is_consumable    = case when input ? 'is_consumable' then as_bool(input->>'is_consumable') else is_consumable end,
      total_qty        = total_qty + diff,
      available_qty    = available_qty + diff,
      updated_at       = now()
    where item_id = v_id returning * into it;

    if diff <> 0 then
      perform ledger(v_id, '', '', case when diff > 0 then 'ADJUST_IN' else 'ADJUST_OUT' end,
                     diff, 0, 0, diff, it.available_qty, sess->>'student_id', 'แก้ไขข้อมูลอุปกรณ์');
    end if;
    perform bump_catalog_version();
    return jsonb_build_object('item_id', v_id, 'created', false);
  end if;

  -- สร้างใหม่: ITM-0001, ITM-0002, ...
  select coalesce(max(as_int(substring(item_id from '^ITM-(\d+)$'))), 0) + 1 into n from items;
  v_id := 'ITM-' || lpad(n::text, 4, '0');
  total := greatest(0, as_int(input->>'total_qty'));

  insert into items (item_id, name_th, name_en, category_id, description, is_consumable, unit,
    total_qty, available_qty, min_qty, max_per_borrow, default_due_days, storage_location, status, tags)
  values (v_id, v_name, as_text(input->>'name_en'), as_text(input->>'category_id'),
    as_text(input->>'description'), as_bool(input->>'is_consumable'),
    coalesce(nullif(as_text(input->>'unit'), ''), 'ชิ้น'), total, total,
    as_int(input->>'min_qty'), as_int(input->>'max_per_borrow'),
    case when as_text(input->>'default_due_days') = '' then null else as_int(input->>'default_due_days') end,
    as_text(input->>'storage_location'), coalesce(nullif(as_text(input->>'status'), ''), 'ACTIVE'),
    as_text(input->>'tags'));

  if total > 0 then
    perform ledger(v_id, '', '', 'ADJUST_IN', total, 0, 0, total, total, sess->>'student_id', 'เพิ่มอุปกรณ์ใหม่');
  end if;
  perform bump_catalog_version();
  return jsonb_build_object('item_id', v_id, 'created', true);
end $$;

create or replace function h_admin_upsert_category(p jsonb, sess jsonb) returns jsonb
language plpgsql as $$
declare
  input jsonb := coalesce(p->'category', '{}'::jsonb);
  v_id  text := as_text(input->>'category_id');
  v_name text := as_text(input->>'name_th');
  n     integer;
begin
  if v_name = '' then perform app_error('BAD_REQUEST', 'ต้องระบุชื่อหมวดหมู่'); end if;

  if v_id <> '' and exists (select 1 from categories where category_id = v_id) then
    update categories set name_th = v_name, name_en = as_text(input->>'name_en'),
      icon = as_text(input->>'icon'), sort_order = as_int(input->>'sort_order'),
      status = coalesce(nullif(as_text(input->>'status'), ''), 'ACTIVE')
    where category_id = v_id;
    perform bump_catalog_version();
    return jsonb_build_object('category_id', v_id, 'created', false);
  end if;

  select coalesce(max(as_int(substring(category_id from '^CAT-(\d+)$'))), 0) + 1 into n from categories;
  v_id := 'CAT-' || lpad(n::text, 2, '0');
  insert into categories (category_id, name_th, name_en, icon, sort_order)
  values (v_id, v_name, as_text(input->>'name_en'),
          coalesce(nullif(as_text(input->>'icon'), ''), '📦'),
          coalesce(nullif(as_int(input->>'sort_order'), 0), 99));
  perform bump_catalog_version();
  return jsonb_build_object('category_id', v_id, 'created', true);
end $$;

-- ---------- ค่าตั้งค่า ----------

create or replace function h_get_public_config(p jsonb, sess jsonb) returns jsonb
language sql stable as $$
  select jsonb_build_object(
    'app_name', cfg_text('app_name', 'E-Borrow'),
    'levels', cfg_json('levels_json', '[]'),
    'departments', cfg_json('departments_json', '[]'),
    'announcement', cfg_text('announcement', ''),
    'require_photo_on_return', cfg_bool('require_photo_on_return', true))
$$;

create or replace function h_admin_get_config(p jsonb, sess jsonb) returns jsonb
language sql stable as $$
  select jsonb_build_object('config', coalesce(jsonb_agg(jsonb_build_object(
    'key', key, 'value', value, 'type', type, 'description_th', description_th) order by key), '[]'))
  from config
  -- ค่าที่ระบบจัดการเอง ไม่ให้แก้จากหน้าเว็บ
  where key not in ('catalog_version', 'project_url')
$$;

create or replace function h_admin_set_config(p jsonb, sess jsonb) returns jsonb
language plpgsql as $$
declare
  k text := as_text(p->>'key');
  v text := coalesce(p->>'value', '');
begin
  if k = '' then perform app_error('BAD_REQUEST', 'ต้องระบุ key'); end if;
  if k in ('catalog_version', 'project_url') then perform app_error('FORBIDDEN'); end if;
  insert into config (key, value) values (k, v)
  on conflict (key) do update set value = excluded.value;
  if k in ('levels_json', 'departments_json') then perform bump_catalog_version(); end if;
  return jsonb_build_object('key', k, 'value', v);
end $$;

-- ---------- นักเรียน ----------

create or replace function student_json(s students) returns jsonb
language sql stable as $$
  select jsonb_build_object(
    'student_id', s.student_id, 'full_name', s.full_name, 'level', s.level,
    'department', s.department, 'section', s.section, 'phone', s.phone,
    'status', s.status, 'role', s.role,
    'active_loan_count', s.active_loan_count, 'overdue_count', s.overdue_count,
    'registered_at', iso(s.registered_at))
$$;

create or replace function h_admin_pending_students(p jsonb, sess jsonb) returns jsonb
language sql stable as $$
  select jsonb_build_object('students', coalesce(
    jsonb_agg(student_json(s) order by s.registered_at), '[]'))
  from students s where s.status = 'PENDING'
$$;

create or replace function h_admin_list_students(p jsonb, sess jsonb) returns jsonb
language sql stable as $$
  select jsonb_build_object('students', coalesce(
    jsonb_agg(student_json(s) order by s.student_id), '[]'))
  from students s
  where (coalesce(p->>'level', '') = '' or s.level = p->>'level')
    and (coalesce(p->>'department', '') = '' or s.department = p->>'department')
    and (coalesce(p->>'status', '') = '' or s.status = p->>'status')
    and (coalesce(p->>'q', '') = ''
         or strpos(lower(s.full_name || ' ' || s.student_id), lower(trim(p->>'q'))) > 0)
$$;

create or replace function h_admin_approve_student(p jsonb, sess jsonb) returns jsonb
language plpgsql as $$
declare
  v_id    text := as_text(p->>'student_id');
  approve boolean := coalesce(p->>'approve', 'true') <> 'false';
begin
  update students set status = case when approve then 'ACTIVE' else 'SUSPENDED' end,
    approved_at = now(), approved_by = sess->>'student_id',
    notes = coalesce(nullif(as_text(p->>'note'), ''), notes)
  where student_id = v_id;
  if not found then perform app_error('NOT_FOUND', 'ไม่พบนักเรียนคนนี้'); end if;
  return jsonb_build_object('student_id', v_id,
    'status', case when approve then 'ACTIVE' else 'SUSPENDED' end,
    'message_th', case when approve then 'อนุมัติแล้ว' else 'ปฏิเสธแล้ว' end);
end $$;

create or replace function h_admin_reset_pin(p jsonb, sess jsonb) returns jsonb
language plpgsql as $$
declare
  s students := get_student(as_text(p->>'student_id'), true);
  v_pin text := validate_pin_format(p->>'new_pin', s.role = 'ADMIN');
begin
  update students set pin_hash = hash_pin(v_pin),
    failed_pin_count = 0, locked_until = null
  where student_id = s.student_id;
  perform revoke_all_sessions(s.student_id, null);
  return jsonb_build_object('ok', true, 'message_th', 'รีเซ็ต PIN เรียบร้อย แจ้ง PIN ใหม่ให้นักเรียน');
end $$;

-- ---------- คิวคำขอ + ใบรายการหยิบของ (เรียงตามตู้ ครูเดินหยิบรอบเดียวจบ) ----------

create or replace function h_admin_pending_requests(p jsonb, sess jsonb) returns jsonb
language sql stable as $$
  with t as (
    select * from transactions where status in ('REQUESTED', 'APPROVED')
  )
  select jsonb_build_object(
    'transactions', coalesce((select jsonb_agg(serialize_txn(t) order by t.requested_at) from t), '[]'),
    'pick_list', coalesce((
      select jsonb_agg(jsonb_build_object(
        'txn_id', t.txn_id, 'student_name', t.student_name_snapshot,
        'item_name', l.item_name_snapshot,
        'qty', coalesce(nullif(l.qty_approved, 0), l.qty_requested),
        'unit', l.unit_snapshot,
        'storage_location', coalesce(nullif(l.storage_location_snapshot, ''), 'ไม่ระบุตำแหน่ง'),
        'is_consumable', l.is_consumable_snapshot)
        order by coalesce(nullif(l.storage_location_snapshot, ''), 'ไม่ระบุตำแหน่ง'), t.requested_at)
      from t join transaction_lines l using (txn_id)
      where l.line_status <> 'CANCELLED'), '[]'),
    'counts', jsonb_build_object(
      'awaiting_approval', (select count(*) from t where status = 'REQUESTED'),
      'awaiting_issue', (select count(*) from t where status = 'APPROVED')))
$$;

create or replace function h_admin_approve_request(p jsonb, sess jsonb) returns jsonb
language plpgsql as $$
declare
  t      transactions := load_txn(as_text(p->>'txn_id'), true);
  ov     jsonb := '{}'::jsonb;
  l      transaction_lines;
  appr   integer;
  outst  integer := 0;
  bumped boolean := false;
begin
  if t.status <> 'REQUESTED' then
    perform app_error('INVALID_STATE', 'รายการนี้ผ่านขั้นตอนอนุมัติไปแล้ว');
  end if;
  select coalesce(jsonb_object_agg(o->>'line_id', as_int(o->>'qty_approved')), '{}') into ov
  from jsonb_array_elements(coalesce(p->'line_overrides', '[]'::jsonb)) o;

  for l in select * from transaction_lines where txn_id = t.txn_id loop
    appr := l.qty_approved;
    -- ครูลดจำนวน — ส่วนต่างต้องคืนเข้าชั้นทันที ไม่งั้นจองค้าง
    if ov ? l.line_id then
      if (ov->>l.line_id)::integer < 0 or (ov->>l.line_id)::integer > appr then
        perform app_error('BAD_REQUEST', 'จำนวนที่อนุมัติต้องอยู่ระหว่าง 0 ถึง ' || appr);
      end if;
      if appr - (ov->>l.line_id)::integer > 0 then
        perform stock_unreserve(l.item_id, appr - (ov->>l.line_id)::integer, sess->>'student_id',
                                t.txn_id, l.line_id, 'ครูลดจำนวนที่อนุมัติ');
        bumped := true;
      end if;
      appr := (ov->>l.line_id)::integer;
    end if;

    update transaction_lines set qty_approved = appr,
      line_status = case when appr > 0 then 'APPROVED' else 'CANCELLED' end
    where line_id = l.line_id;
    if not l.is_consumable_snapshot then outst := outst + appr; end if;
  end loop;

  update transactions set status = 'APPROVED', approved_at = now(),
    handled_by = sess->>'student_id', outstanding_qty = outst, updated_at = now()
  where txn_id = t.txn_id;
  if bumped then perform bump_catalog_version(); end if;
  return jsonb_build_object('txn_id', t.txn_id, 'status', 'APPROVED');
end $$;

create or replace function h_admin_reject_request(p jsonb, sess jsonb) returns jsonb
language plpgsql as $$
declare t transactions := load_txn(as_text(p->>'txn_id'), true);
begin
  if t.status <> 'REQUESTED' then
    perform app_error('INVALID_STATE', 'ปฏิเสธได้เฉพาะคำขอที่ยังไม่อนุมัติ');
  end if;
  perform release_reservation(t, sess->>'student_id', 'REJECTED',
                              coalesce(nullif(as_text(p->>'reason'), ''), 'ครูปฏิเสธคำขอ'));
  return jsonb_build_object('txn_id', t.txn_id, 'status', 'REJECTED');
end $$;

/**
 * จ่ายของจริง — จุดที่ของเปลี่ยนมือและกำหนดคืนเริ่มนับ
 * จ่ายจาก REQUESTED ได้เลย (ปุ่ม "อนุมัติ+จ่าย")
 * ถ้าทุกบรรทัดเป็นของสิ้นเปลือง รายการปิดทันที (CLOSED_CONSUMED)
 */
create or replace function h_admin_issue_transaction(p jsonb, sess jsonb) returns jsonb
language plpgsql as $$
declare
  t        transactions := load_txn(as_text(p->>'txn_id'), true);
  ov       jsonb;
  l        transaction_lines;
  issued   integer;
  st       text;
  outst    integer := 0;
  returnable boolean := false;
  max_due  timestamptz;
  new_status text;
begin
  if t.status not in ('APPROVED', 'REQUESTED') then
    perform app_error('INVALID_STATE', 'รายการนี้จ่ายของไปแล้ว');
  end if;
  select coalesce(jsonb_object_agg(o->>'line_id', as_int(o->>'qty_issued')), '{}') into ov
  from jsonb_array_elements(coalesce(p->'line_overrides', '[]'::jsonb)) o;

  for l in select * from transaction_lines where txn_id = t.txn_id and line_status <> 'CANCELLED' loop
    issued := case when ov ? l.line_id then (ov->>l.line_id)::integer else l.qty_approved end;
    perform stock_issue(l.item_id, l.qty_approved, issued, l.is_consumable_snapshot,
                        sess->>'student_id', t.txn_id, l.line_id);

    if issued <= 0 then st := 'CANCELLED';
    elsif l.is_consumable_snapshot then st := 'CONSUMED';   -- ของสิ้นเปลืองปิดตั้งแต่จ่าย
    else
      st := 'ISSUED';
      returnable := true;
      outst := outst + issued;
      if max_due is null or l.line_due_at > max_due then max_due := l.line_due_at; end if;
    end if;
    update transaction_lines set qty_issued = issued, line_status = st where line_id = l.line_id;
  end loop;

  new_status := case when returnable then 'IN_USE' else 'CLOSED_CONSUMED' end;
  update transactions set status = new_status, issued_at = now(),
    due_at = coalesce(max_due, due_at), handled_by = sess->>'student_id',
    outstanding_qty = outst, updated_at = now(),
    returned_at = case when returnable then returned_at else now() end,
    approved_at = case when t.status = 'REQUESTED' then now() else approved_at end
  where txn_id = t.txn_id returning * into t;

  -- ของสิ้นเปลืองล้วน = ปิดรายการทันที ปลดโควต้าให้นักเรียน
  if not returnable then perform close_loan_for_student(t.student_id); end if;
  perform bump_catalog_version();

  return jsonb_build_object('txn_id', t.txn_id, 'status', new_status, 'due_at', iso(t.due_at),
    'message_th', case when returnable
      then 'จ่ายของเรียบร้อย กำหนดคืน '
           || to_char(t.due_at at time zone 'Asia/Bangkok', 'FMDD/FMMM/YYYY HH24:MI') || ' น.'
      else 'จ่ายของสิ้นเปลืองเรียบร้อย ปิดรายการแล้ว' end);
end $$;

create or replace function h_admin_mark_lost(p jsonb, sess jsonb) returns jsonb
language plpgsql as $$
declare
  t      transactions := load_txn(as_text(p->>'txn_id'), true);
  v_reason text := coalesce(nullif(as_text(p->>'reason'), ''), 'ครูบันทึกว่าสูญหาย');
  res    jsonb;
begin
  res := process_return(t.txn_id,
    jsonb_build_array(jsonb_build_object('line_id', as_text(p->>'line_id'), 'qty_returned', 0,
      'qty_lost', as_int(p->>'qty'), 'condition', 'LOST', 'note', v_reason)),
    sess, false, 'LOST', v_reason, null);
  return jsonb_build_object('txn_id', t.txn_id, 'line_id', as_text(p->>'line_id'),
    'qty_lost', (select qty_lost from transaction_lines where line_id = as_text(p->>'line_id')));
end $$;

-- ---------- แดชบอร์ด ----------

create or replace function h_admin_dashboard(p jsonb, sess jsonb) returns jsonb
language sql stable as $$
  with out_now as (
    select * from transactions where status in ('IN_USE', 'PARTIALLY_RETURNED', 'OVERDUE')
  )
  select jsonb_build_object(
    'out_now', coalesce((select jsonb_agg(serialize_txn(o) order by o.due_at) from out_now o), '[]'),
    'overdue', coalesce((select jsonb_agg(serialize_txn(o) order by o.due_at) from out_now o
                         where o.status = 'OVERDUE'), '[]'),
    'low_stock', coalesce((
      select jsonb_agg(jsonb_build_object('item_id', item_id, 'name_th', name_th,
        'available_qty', available_qty, 'min_qty', min_qty, 'unit', unit) order by name_th)
      from items where min_qty > 0 and available_qty <= min_qty and status = 'ACTIVE'), '[]'),
    'reconcile', (select mismatches from reconcile_reports order by id desc limit 1),
    'stats', jsonb_build_object(
      'pending_requests', (select count(*) from transactions where status = 'REQUESTED'),
      'awaiting_issue', (select count(*) from transactions where status = 'APPROVED'),
      'items_out', (select count(*) from out_now),
      'overdue_count', (select count(*) from out_now where status = 'OVERDUE'),
      'pending_students', (select count(*) from students where status = 'PENDING'),
      'total_items', (select count(*) from items),
      'storage_mb', round(coalesce((select sum((metadata->>'size')::bigint)
                                    from storage.objects
                                    where bucket_id in ('return-photos', 'item-photos')), 0) / 1e6, 1),
      'storage_limit_mb', 1024))
$$;
