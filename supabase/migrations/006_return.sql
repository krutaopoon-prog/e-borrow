-- =============================================================
-- 006_return.sql — การคืนของ + รูปถ่าย
--
--   initiateReturn  → ตรวจรายการที่จะคืน ออก upload_token (ตั๋วอัปรูปใช้ครั้งเดียว)
--   [หน้าเว็บอัปรูปตรงไป Supabase Storage ด้วย path {upload_token}/...]
--   finalizeReturn  → ตรวจว่ามีรูปจริง แล้วตัดสต็อกและปิดรายการในทรานแซกชันเดียว
--
-- รูปไม่ผ่านฐานข้อมูลเลย — วิ่งตรงจากมือถือไป Storage (เร็วกว่าเดิมมาก)
-- =============================================================

/** URL สาธารณะของไฟล์ใน Storage — project_url ตั้งตอนติดตั้ง (ดู README) */
create or replace function storage_url(bucket text, path text) returns text
language plpgsql stable as $$
begin
  if coalesce(path, '') = '' then return ''; end if;
  if cfg_text('project_url') = '' then
    perform app_error('INTERNAL_ERROR', 'ยังไม่ได้ตั้งค่า project_url ในตาราง config กรุณาแจ้งครู');
  end if;
  return rtrim(cfg_text('project_url'), '/') || '/storage/v1/object/public/' || bucket || '/' || path;
end $$;

create or replace function new_upload_ticket(bucket text, purpose text, ref_id text, actor text)
returns text language plpgsql as $$
declare t text := left(random_token(), 32);
begin
  insert into upload_tickets (ticket, bucket, purpose, ref_id, created_by, expires_at)
  values (t, bucket, purpose, ref_id, actor, now() + interval '1 hour');
  return t;
end $$;

/** ไฟล์ล่าสุดที่อัปด้วยตั๋วนี้ (null ถ้ายังไม่ได้อัป) */
create or replace function ticket_object(p_bucket text, p_ticket text) returns text
language sql stable as $$
  select o.name from storage.objects o
  where o.bucket_id = p_bucket and o.name like p_ticket || '/%'
  order by o.created_at desc limit 1
$$;

-- ---------- นักเรียนคืนเอง ----------

create or replace function h_initiate_return(p jsonb, sess jsonb) returns jsonb
language plpgsql as $$
declare
  t         transactions := load_txn(as_text(p->>'txn_id'));
  input     jsonb;
  l         transaction_lines;
  good      integer;
  lost      integer;
  outst     integer;
  validated jsonb := '[]'::jsonb;
  v_ret     text;
  v_token   text;
begin
  if jsonb_array_length(coalesce(p->'lines', '[]'::jsonb)) = 0 then
    perform app_error('BAD_REQUEST', 'ไม่ได้เลือกรายการที่จะคืน');
  end if;
  if t.student_id <> sess->>'student_id' and sess->>'role' <> 'ADMIN' then
    perform app_error('FORBIDDEN');
  end if;
  if t.status not in ('IN_USE', 'PARTIALLY_RETURNED', 'OVERDUE') then
    perform app_error('INVALID_STATE', 'รายการนี้ไม่อยู่ในสถานะที่คืนได้');
  end if;

  -- ตรวจตั้งแต่ตอนนี้ ไม่ต้องรอถ่ายรูปเสร็จแล้วค่อยบอกว่าผิด
  for input in select * from jsonb_array_elements(p->'lines') loop
    select * into l from transaction_lines
    where txn_id = t.txn_id and line_id = as_text(input->>'line_id');
    if not found then
      perform app_error('NOT_FOUND', 'ไม่พบรายการย่อย: ' || coalesce(input->>'line_id', ''));
    end if;
    if l.is_consumable_snapshot then
      perform app_error('INVALID_STATE', '"' || l.item_name_snapshot || '" เป็นของสิ้นเปลือง ไม่ต้องคืน');
    end if;

    good := as_int(input->>'qty_returned');
    lost := as_int(input->>'qty_lost');
    outst := l.qty_issued - l.qty_returned - l.qty_lost;
    if good < 0 or lost < 0 then perform app_error('BAD_REQUEST', 'จำนวนไม่ถูกต้อง'); end if;
    if good + lost <= 0 then continue; end if;
    if good + lost > outst then
      perform app_error('BAD_REQUEST', '"' || l.item_name_snapshot || '" ค้างอยู่ ' || outst || ' ชิ้น');
    end if;

    validated := validated || jsonb_build_object(
      'line_id', l.line_id, 'qty_returned', good, 'qty_lost', lost,
      'condition', coalesce(nullif(as_text(input->>'condition'), ''), 'OK'),
      'note', as_text(input->>'note'));
  end loop;

  if jsonb_array_length(validated) = 0 then
    perform app_error('BAD_REQUEST', 'ไม่มีรายการที่จะคืน');
  end if;

  v_ret := 'RET-' || left(random_token(), 16);
  v_token := new_upload_ticket('return-photos', 'RETURN', v_ret, sess->>'student_id');
  insert into pending_returns (return_id, upload_token, txn_id, student_id, actor_id, lines)
  values (v_ret, v_token, t.txn_id, t.student_id, sess->>'student_id', validated);

  return jsonb_build_object(
    'return_id', v_ret,
    'upload_token', v_token,
    'upload_bucket', 'return-photos',
    'upload_required', cfg_bool('require_photo_on_return', true),
    'lines', validated);
end $$;

create or replace function h_finalize_return(p jsonb, sess jsonb) returns jsonb
language plpgsql as $$
declare
  pr     pending_returns;
  v_path text;
begin
  select * into pr from pending_returns where return_id = as_text(p->>'return_id') for update;
  if not found or pr.finalized_at is not null or pr.created_at < now() - interval '1 hour' then
    perform app_error('INVALID_STATE', 'การคืนหมดเวลา กรุณาเริ่มใหม่');
  end if;
  -- upload_token เป็นกุญแจใช้ครั้งเดียว — รู้แค่ return_id ยืนยันแทนไม่ได้
  if pr.upload_token <> as_text(p->>'upload_token') then perform app_error('FORBIDDEN'); end if;
  if pr.student_id <> sess->>'student_id' and sess->>'role' <> 'ADMIN' then
    perform app_error('FORBIDDEN');
  end if;

  v_path := ticket_object('return-photos', pr.upload_token);
  if v_path is null and cfg_bool('require_photo_on_return', true) then
    perform app_error('PHOTO_REQUIRED');
  end if;

  update pending_returns set finalized_at = now() where return_id = pr.return_id;
  update upload_tickets set used = true where ticket = pr.upload_token;

  return process_return(pr.txn_id, pr.lines, sess, false, '', '', v_path);
end $$;

-- ---------- ตัดสต็อกและปิดรายการ (ใช้ร่วมกับครูรับคืนแทน) ----------

/**
 * by_admin = ครูกดรับคืนเอง (ไม่บังคับรูป)
 * ครูไม่ระบุรายการ = คืนทุกอย่างที่ค้างอยู่ในสภาพดี
 */
create or replace function process_return(p_txn text, p_lines jsonb, sess jsonb, by_admin boolean,
                                          p_cond text, p_note text, photo_path text)
returns jsonb language plpgsql as $$
declare
  t       transactions := load_txn(p_txn, true);
  input   jsonb;
  l       transaction_lines;
  good    integer;
  lost    integer;
  any_lost boolean := false;
  n       integer := 0;
  outst   integer;
  actor   text := sess->>'student_id';
begin
  if t.status not in ('IN_USE', 'PARTIALLY_RETURNED', 'OVERDUE') then
    perform app_error('INVALID_STATE', 'รายการนี้ไม่อยู่ในสถานะที่คืนได้');
  end if;

  if by_admin and jsonb_array_length(coalesce(p_lines, '[]'::jsonb)) = 0 then
    select coalesce(jsonb_agg(jsonb_build_object(
      'line_id', line_id, 'qty_returned', qty_issued - qty_returned - qty_lost, 'qty_lost', 0,
      'condition', coalesce(nullif(p_cond, ''), 'OK'))), '[]'::jsonb)
    into p_lines
    from transaction_lines
    where txn_id = p_txn and not is_consumable_snapshot and qty_issued - qty_returned - qty_lost > 0;
  end if;

  for input in select * from jsonb_array_elements(coalesce(p_lines, '[]'::jsonb)) loop
    select * into l from transaction_lines
    where txn_id = p_txn and line_id = as_text(input->>'line_id') for update;
    if not found then perform app_error('NOT_FOUND', 'ไม่พบรายการย่อย'); end if;

    good := as_int(input->>'qty_returned');
    lost := as_int(input->>'qty_lost');
    if good + lost <= 0 then continue; end if;

    if l.is_consumable_snapshot then
      perform app_error('INVALID_STATE', '"' || l.item_name_snapshot || '" เป็นของสิ้นเปลือง ไม่ต้องคืน');
    end if;
    -- ตรวจซ้ำในล็อก — ระหว่างถ่ายรูป ครูอาจกดรับคืนไปแล้ว
    if good + lost > l.qty_issued - l.qty_returned - l.qty_lost then
      perform app_error('BAD_REQUEST',
        'คืนเกินจำนวนที่ยืมไป (ค้างอยู่ ' || (l.qty_issued - l.qty_returned - l.qty_lost) || ')');
    end if;

    perform stock_return(l.item_id, good, lost, actor, p_txn, l.line_id,
                         as_text(input->>'condition'), as_text(input->>'note'));

    outst := l.qty_issued - (l.qty_returned + good) - (l.qty_lost + lost);
    update transaction_lines set
      qty_returned = qty_returned + good,
      qty_lost = qty_lost + lost,
      line_status = case when outst > 0 then 'PARTIALLY_RETURNED'
                         when qty_lost + lost > 0 and qty_returned + good = 0 then 'LOST'
                         else 'RETURNED' end,
      note = coalesce(nullif(as_text(input->>'note'), ''), note)
    where line_id = l.line_id;

    n := n + 1;
    if lost > 0 then any_lost := true; end if;
  end loop;

  if n = 0 then perform app_error('BAD_REQUEST', 'ไม่มีรายการที่จะคืน'); end if;

  if photo_path is not null then
    update transactions set return_photo_path = photo_path,
      return_photo_url = storage_url('return-photos', photo_path), updated_at = now()
    where txn_id = p_txn;
  end if;

  outst := recompute_txn_closure(p_txn,
    case when any_lost then 'PARTIAL' else coalesce(nullif(p_cond, ''), 'OK') end, p_note);
  perform bump_catalog_version();

  return jsonb_build_object(
    'txn_id', p_txn,
    'status', case when outst <= 0 then 'RETURNED' else 'PARTIALLY_RETURNED' end,
    'outstanding_qty', greatest(0, outst),
    'photo_url', (select return_photo_url from transactions where txn_id = p_txn),
    'message_th', case when outst <= 0 then 'คืนอุปกรณ์ครบแล้ว ขอบคุณครับ'
                       else 'คืนบางส่วนแล้ว ยังค้างอีก ' || outst || ' ชิ้น' end);
end $$;

/** ตรวจว่ารายการปิดได้หรือยัง หลังมีการคืน/แจ้งหาย — คืนจำนวนที่ยังค้าง */
create or replace function recompute_txn_closure(p_txn text, p_cond text, p_note text)
returns integer language plpgsql as $$
declare
  outst integer;
  v_sid text;
begin
  select coalesce(sum(qty_issued - qty_returned - qty_lost), 0) into outst
  from transaction_lines
  where txn_id = p_txn and not is_consumable_snapshot and line_status <> 'CANCELLED';

  if outst <= 0 then
    update transactions set outstanding_qty = 0, status = 'RETURNED', returned_at = now(),
      condition_on_return = coalesce(nullif(p_cond, ''), condition_on_return),
      return_note = coalesce(nullif(p_note, ''), return_note), updated_at = now()
    where txn_id = p_txn returning student_id into v_sid;
    perform close_loan_for_student(v_sid);
  else
    update transactions set outstanding_qty = outst, status = 'PARTIALLY_RETURNED', updated_at = now()
    where txn_id = p_txn;
  end if;
  return outst;
end $$;

/** ปิดรายการยืม 1 ใบ → ลดโควต้า และนับ overdue ใหม่จากความจริง */
create or replace function close_loan_for_student(v_sid text) returns void
language sql as $$
  update students set
    active_loan_count = greatest(0, active_loan_count - 1),
    overdue_count = (select count(*) from transactions where student_id = v_sid and status = 'OVERDUE')
  where student_id = v_sid;
$$;

-- ---------- ครู ----------

create or replace function h_admin_confirm_return(p jsonb, sess jsonb) returns jsonb
language sql as $$
  select process_return(as_text(p->>'txn_id'), p->'lines', sess, true,
                        as_text(p->>'condition'), as_text(p->>'note'), null);
$$;

create or replace function h_admin_create_item_upload_ticket(p jsonb, sess jsonb) returns jsonb
language plpgsql as $$
declare v_item text := as_text(p->>'item_id');
begin
  if not exists (select 1 from items where item_id = v_item) then
    perform app_error('NOT_FOUND', 'ไม่พบอุปกรณ์');
  end if;
  return jsonb_build_object(
    'upload_token', new_upload_ticket('item-photos', 'ITEM', v_item, sess->>'student_id'),
    'upload_bucket', 'item-photos');
end $$;

create or replace function h_admin_upload_item_photo(p jsonb, sess jsonb) returns jsonb
language plpgsql as $$
declare
  tk     upload_tickets;
  it     items;
  v_path text;
begin
  select * into tk from upload_tickets
  where ticket = as_text(p->>'upload_token') and purpose = 'ITEM' for update;
  if not found or tk.used or tk.expires_at < now() then
    perform app_error('INVALID_STATE', 'การอัปโหลดหมดเวลา กรุณาลองใหม่');
  end if;

  select * into it from items where item_id = tk.ref_id for update;
  if not found then perform app_error('NOT_FOUND', 'ไม่พบอุปกรณ์'); end if;

  v_path := ticket_object('item-photos', tk.ticket);
  if v_path is null then perform app_error('BAD_REQUEST', 'ไม่พบข้อมูลรูป'); end if;

  -- รูปเดิมเข้าคิวลบ ไม่ให้พื้นที่รก
  if it.photo_path <> '' then
    insert into storage_delete_queue (bucket, path, reason)
    values ('item-photos', it.photo_path, 'เปลี่ยนรูปอุปกรณ์ ' || it.item_id);
  end if;

  update upload_tickets set used = true where ticket = tk.ticket;
  update items set photo_path = v_path, photo_url = storage_url('item-photos', v_path),
    updated_at = now()
  where item_id = it.item_id;
  perform bump_catalog_version();

  return jsonb_build_object('url', storage_url('item-photos', v_path));
end $$;
