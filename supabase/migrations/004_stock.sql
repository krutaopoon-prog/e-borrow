-- =============================================================
-- 004_stock.sql — การเปลี่ยนแปลงจำนวนสต็อกทั้งหมด (แกนความถูกต้องของระบบ)
--
-- กฎที่ต้องเป็นจริงเสมอ:
--   ของคืนได้:     available + reserved + out == total
--   ของสิ้นเปลือง:  available + reserved == total   (out = 0 เสมอ)
--
-- ต่างจาก Apps Script เดิม:
--   - 1 คำขอ = 1 ทรานแซกชัน พังกลางทางก็ rollback ทั้งก้อน ไม่มี "เขียนครึ่งเดียว"
--   - ล็อกเฉพาะแถวอุปกรณ์ที่เกี่ยวข้อง (FOR UPDATE) แทนการล็อกทั้งระบบ
--     → นักเรียน 30 คนยืมของคนละชิ้นพร้อมกันได้ ไม่ต้องต่อคิว
--   - ต้องเรียก lock_items() ก่อนอ่านยอด และล็อกเรียงตาม item_id เสมอ (กัน deadlock)
-- =============================================================

create or replace function lock_items(ids text[]) returns void
language sql as $$
  select 1 from items where item_id = any (ids) order by item_id for update;
$$;

create or replace function ledger(
  p_item text, p_txn text, p_line text, p_event text,
  d_available integer, d_reserved integer, d_out integer, d_total integer,
  p_available_after integer, p_actor text, p_reason text default '')
returns void language sql as $$
  insert into stock_ledger (item_id, txn_id, line_id, event_type, delta_available, delta_reserved,
                            delta_out, delta_total, available_after, actor_id, reason)
  values (p_item, coalesce(p_txn, ''), coalesce(p_line, ''), p_event, d_available, d_reserved,
          d_out, d_total, p_available_after, coalesce(p_actor, ''), coalesce(p_reason, ''));
$$;

/** จองสต็อก (นักเรียนกดยืม) — ต้อง lock_items ก่อน */
create or replace function stock_reserve(p_item text, qty integer, actor text, p_txn text)
returns items language plpgsql as $$
declare it items;
begin
  select * into it from items where item_id = p_item;
  if not found then
    perform app_error('NOT_FOUND', 'ไม่พบอุปกรณ์: ' || p_item);
  end if;
  if it.status <> 'ACTIVE' then
    perform app_error('INVALID_STATE', 'อุปกรณ์ "' || it.name_th || '" ไม่เปิดให้ยืม');
  end if;
  if qty <= 0 then
    perform app_error('BAD_REQUEST', 'จำนวนต้องมากกว่า 0');
  end if;
  if it.max_per_borrow > 0 and qty > it.max_per_borrow then
    perform app_error('LIMIT_EXCEEDED',
      'ยืม "' || it.name_th || '" ได้ครั้งละไม่เกิน ' || it.max_per_borrow || ' ' || it.unit,
      jsonb_build_object('item_id', it.item_id, 'max_per_borrow', it.max_per_borrow));
  end if;
  -- ตรวจยอด "ข้างในล็อก" เท่านั้น — ค่าที่หน้าเว็บเห็นเก่าเสมอ
  if qty > it.available_qty then
    perform app_error('INSUFFICIENT_STOCK',
      '"' || it.name_th || '" เหลือ ' || it.available_qty || ' ' || it.unit,
      jsonb_build_object('item_id', it.item_id, 'available', it.available_qty, 'requested', qty));
  end if;

  update items set available_qty = available_qty - qty, reserved_qty = reserved_qty + qty,
    updated_at = now()
  where item_id = p_item returning * into it;

  perform ledger(p_item, p_txn, '', 'RESERVE', -qty, qty, 0, 0, it.available_qty, actor);
  return it;
end $$;

/** คืนการจอง (ปฏิเสธ / ยกเลิก / หมดอายุ / ครูลดจำนวน) */
create or replace function stock_unreserve(p_item text, qty integer, actor text, p_txn text,
                                           p_line text, reason text)
returns void language plpgsql as $$
declare v_after integer;
begin
  if qty <= 0 then return; end if;
  update items set available_qty = available_qty + qty,
    reserved_qty = greatest(0, reserved_qty - qty), updated_at = now()
  where item_id = p_item returning available_qty into v_after;
  if not found then return; end if;   -- อุปกรณ์ถูกลบไปแล้ว ข้ามไป ไม่ให้ทั้งรายการพัง
  perform ledger(p_item, p_txn, p_line, 'UNRESERVE', qty, -qty, 0, 0, v_after, actor, reason);
end $$;

/**
 * จ่ายของจริง — จุดที่ของสิ้นเปลืองกับของคืนได้แยกทางกัน
 * จ่ายน้อยกว่าที่อนุมัติ → ส่วนต่างคืนเข้าชั้น
 */
create or replace function stock_issue(p_item text, approved integer, issued integer,
                                       consumable boolean, actor text, p_txn text, p_line text)
returns void language plpgsql as $$
declare
  it items;
  shortfall integer := approved - issued;
begin
  if issued < 0 or issued > approved then
    perform app_error('BAD_REQUEST', 'จำนวนที่จ่ายต้องอยู่ระหว่าง 0 ถึง ' || approved);
  end if;
  select * into it from items where item_id = p_item;
  if not found then perform app_error('NOT_FOUND', 'ไม่พบอุปกรณ์: ' || p_item); end if;

  if consumable then
    -- ของสิ้นเปลือง: หายจากระบบถาวร ไม่แตะ out เพราะไม่รอคืน
    update items set reserved_qty = greatest(0, reserved_qty - issued - shortfall),
      total_qty = greatest(0, total_qty - issued),
      available_qty = available_qty + shortfall, updated_at = now()
    where item_id = p_item returning * into it;
    perform ledger(p_item, p_txn, p_line, 'CONSUME', shortfall, -issued - shortfall, 0, -issued,
                   it.available_qty, actor);
  else
    -- ของคืนได้: ย้ายจาก reserved ไป out (available ถูกหักไปแล้วตอนจอง)
    update items set reserved_qty = greatest(0, reserved_qty - issued - shortfall),
      out_qty = out_qty + issued,
      available_qty = available_qty + shortfall, updated_at = now()
    where item_id = p_item returning * into it;
    perform ledger(p_item, p_txn, p_line, 'ISSUE', shortfall, -issued - shortfall, issued, 0,
                   it.available_qty, actor);
  end if;
end $$;

/** รับคืน — เฉพาะของคืนได้ good = คืนสภาพดี, lost = หาย/พัง (หักออกจาก total) */
create or replace function stock_return(p_item text, good integer, lost integer, actor text,
                                        p_txn text, p_line text, cond text, note text)
returns void language plpgsql as $$
declare v_after integer;
begin
  if good < 0 or lost < 0 then perform app_error('BAD_REQUEST', 'จำนวนไม่ถูกต้อง'); end if;
  if not exists (select 1 from items where item_id = p_item) then
    perform app_error('NOT_FOUND', 'ไม่พบอุปกรณ์: ' || p_item);
  end if;

  if good > 0 then
    update items set available_qty = available_qty + good, out_qty = greatest(0, out_qty - good),
      updated_at = now()
    where item_id = p_item returning available_qty into v_after;
    perform ledger(p_item, p_txn, p_line, 'RETURN', good, 0, -good, 0, v_after, actor, cond);
  end if;

  if lost > 0 then
    update items set out_qty = greatest(0, out_qty - lost), total_qty = greatest(0, total_qty - lost),
      updated_at = now()
    where item_id = p_item returning available_qty into v_after;
    perform ledger(p_item, p_txn, p_line, 'LOST', 0, 0, -lost, -lost, v_after, actor,
                   coalesce(nullif(note, ''), 'สูญหาย/ชำรุด'));
  end if;
end $$;

-- ---------- ปรับสต็อกด้วยมือ (ครูซื้อของใหม่ / ตรวจนับ) ----------

create or replace function h_admin_adjust_stock(p jsonb, sess jsonb) returns jsonb
language plpgsql as $$
declare
  v_item   text := as_text(p->>'item_id');
  v_reason text := as_text(p->>'reason');
  it       items;
  delta    integer;
  v_new    integer;
  diff     integer;
begin
  if v_item = '' then perform app_error('BAD_REQUEST', 'ต้องระบุอุปกรณ์'); end if;
  if v_reason = '' then perform app_error('BAD_REQUEST', 'ต้องระบุเหตุผลในการปรับสต็อก'); end if;

  select * into it from items where item_id = v_item for update;
  if not found then perform app_error('NOT_FOUND', 'ไม่พบอุปกรณ์'); end if;

  if coalesce(p->>'delta_total', '') <> '' then
    -- เพิ่ม/ลดจำนวนทั้งหมด เช่น ซื้อตัวต้านทานมาเพิ่ม 100 ตัว
    delta := as_int(p->>'delta_total');
    if it.total_qty + delta < 0 or it.available_qty + delta < 0 then
      perform app_error('BAD_REQUEST', 'ปรับแล้วจำนวนจะติดลบ');
    end if;
    update items set total_qty = total_qty + delta, available_qty = available_qty + delta,
      updated_at = now()
    where item_id = v_item returning * into it;
    perform ledger(v_item, '', '', case when delta >= 0 then 'ADJUST_IN' else 'ADJUST_OUT' end,
                   delta, 0, 0, delta, it.available_qty, sess->>'student_id', v_reason);

  elsif coalesce(p->>'set_available', '') <> '' then
    -- ตรวจนับจริงแล้วตั้งค่าใหม่ (stocktake)
    v_new := as_int(p->>'set_available');
    if v_new < 0 then perform app_error('BAD_REQUEST', 'จำนวนติดลบไม่ได้'); end if;
    diff := v_new - it.available_qty;
    update items set available_qty = v_new, total_qty = greatest(0, total_qty + diff),
      updated_at = now()
    where item_id = v_item returning * into it;
    perform ledger(v_item, '', '', 'STOCKTAKE', diff, 0, 0, diff, v_new, sess->>'student_id', v_reason);

  else
    perform app_error('BAD_REQUEST', 'ต้องระบุ delta_total หรือ set_available');
  end if;

  perform bump_catalog_version();
  return jsonb_build_object('item_id', v_item, 'available_qty', it.available_qty,
                            'total_qty', it.total_qty);
end $$;

-- ---------- กระทบยอด ----------
-- เทียบตัวนับกับความจริงจากรายการยืม ไม่แก้ให้เองถ้าไม่สั่ง
-- (การซ่อมเงียบๆ ซ่อนบั๊กที่ทำให้เพี้ยนตั้งแต่แรก)

create or replace function reconcile_stock(apply_fix boolean) returns jsonb
language plpgsql as $$
declare
  r record;
  problems text[];
  mismatches jsonb := '[]'::jsonb;
  applied integer := 0;
begin
  for r in
    with expected as (
      select item_id,
        sum(case when line_status in ('ISSUED', 'PARTIALLY_RETURNED')
                 then greatest(0, qty_issued - qty_returned - qty_lost) else 0 end) as exp_out,
        sum(case when line_status in ('PENDING', 'APPROVED')
                 then coalesce(nullif(qty_approved, 0), qty_requested) else 0 end) as exp_reserved
      from transaction_lines group by item_id
    )
    select i.*, coalesce(e.exp_out, 0)::integer as exp_out,
           coalesce(e.exp_reserved, 0)::integer as exp_reserved
    from items i left join expected e using (item_id)
    order by i.item_id
    for update of i
  loop
    problems := '{}';
    if r.out_qty <> r.exp_out then
      problems := problems || ('out_qty: มี ' || r.out_qty || ' ควรเป็น ' || r.exp_out);
    end if;
    if r.reserved_qty <> r.exp_reserved then
      problems := problems || ('reserved_qty: มี ' || r.reserved_qty || ' ควรเป็น ' || r.exp_reserved);
    end if;
    if not r.is_consumable and r.available_qty + r.reserved_qty + r.out_qty <> r.total_qty then
      problems := problems || ('ยอดรวมไม่ตรง: available+reserved+out='
        || (r.available_qty + r.reserved_qty + r.out_qty) || ' แต่ total=' || r.total_qty);
    end if;

    if cardinality(problems) > 0 then
      mismatches := mismatches || jsonb_build_object(
        'item_id', r.item_id, 'name_th', r.name_th, 'problems', to_jsonb(problems),
        'current', jsonb_build_object('available', r.available_qty, 'reserved', r.reserved_qty,
                                      'out', r.out_qty, 'total', r.total_qty),
        'expected', jsonb_build_object('reserved', r.exp_reserved, 'out', r.exp_out));
      if apply_fix then
        update items set reserved_qty = r.exp_reserved, out_qty = r.exp_out,
          available_qty = greatest(0, r.total_qty - r.exp_reserved - r.exp_out), updated_at = now()
        where item_id = r.item_id;
        perform ledger(r.item_id, '', '', 'STOCKTAKE', 0, 0, 0, 0,
                       greatest(0, r.total_qty - r.exp_reserved - r.exp_out), 'RECONCILE',
                       'แก้ยอดอัตโนมัติ: ' || array_to_string(problems, '; '));
        applied := applied + 1;
      end if;
    end if;
  end loop;

  if applied > 0 then
    perform bump_catalog_version();
    delete from reconcile_reports;   -- แก้แล้ว แถบเตือนบนแดชบอร์ดหายไป
  end if;
  return jsonb_build_object('mismatches', mismatches, 'applied', applied);
end $$;

create or replace function h_admin_reconcile(p jsonb, sess jsonb) returns jsonb
language plpgsql as $$
declare res jsonb := reconcile_stock(as_bool(p->>'apply'));
begin
  if jsonb_array_length(res->'mismatches') > 0 then
    perform audit(sess->>'student_id', sess->>'role', 'RECONCILE_MISMATCH',
      case when as_bool(p->>'apply') then 'OK' else 'ERROR' end,
      jsonb_build_object('count', jsonb_array_length(res->'mismatches')));
  end if;
  return res;
end $$;
