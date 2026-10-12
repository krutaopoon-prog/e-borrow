-- =============================================================
-- 009_cron.sql — งานอัตโนมัติรายคืน 01:00 น. (เวลาไทย)
--
--   - ทำเครื่องหมายรายการเกินกำหนด + อัปเดตตัวนับของนักเรียน
--   - ปล่อยการจองของคำขอที่ไม่มารับ
--   - ลบรูปตอนคืนที่เก่ากว่า return_photo_retention_days (ค่าเริ่มต้น 120 วัน ≈ 4 เดือน)
--   - ล้าง session / ตั๋ว / ข้อมูลกันส่งซ้ำที่หมดอายุ
--   - กระทบยอดสต็อก → ถ้าไม่ตรง แสดงแถบเตือนบนแดชบอร์ดครู
-- =============================================================

create or replace function nightly_maintenance() returns text
language plpgsql security definer set search_path = public, extensions as $$
declare
  report text[] := '{}';
  n      integer;
  t      transactions;
  hours  integer := cfg_int('request_expiry_hours', 48);
  keep   integer := cfg_int('return_photo_retention_days', 120);
  rec    jsonb;
begin
  -- 1. เกินกำหนด
  update transactions set status = 'OVERDUE', updated_at = now()
  where status in ('IN_USE', 'PARTIALLY_RETURNED') and due_at < now();
  get diagnostics n = row_count;
  report := report || ('เกินกำหนด: ' || n || ' รายการ');

  update students s set overdue_count = coalesce(c.cnt, 0)
  from (select st.student_id, count(tx.txn_id) as cnt
        from students st left join transactions tx
          on tx.student_id = st.student_id and tx.status = 'OVERDUE'
        group by st.student_id) c
  where c.student_id = s.student_id and s.overdue_count <> coalesce(c.cnt, 0);

  -- 2. คำขอค้าง — ถ้าไม่ปล่อย สต็อกจะถูกจองจนแคตตาล็อกเหลือศูนย์
  n := 0;
  for t in
    select * from transactions
    where status in ('REQUESTED', 'APPROVED') and requested_at < now() - make_interval(hours => hours)
  loop
    begin
      t := load_txn(t.txn_id, true);
      if t.status in ('REQUESTED', 'APPROVED') then
        perform release_reservation(t, 'SYSTEM', 'EXPIRED',
                                    'ไม่มารับอุปกรณ์ภายใน ' || hours || ' ชั่วโมง');
        n := n + 1;
      end if;
    exception when others then
      raise warning 'expire % failed: %', t.txn_id, sqlerrm;
    end;
  end loop;
  report := report || ('คำขอหมดอายุ: ' || n || ' รายการ');

  -- 3. รูปตอนคืนหมดอายุ → เข้าคิวลบ (Edge Function storage-cleanup ลบไฟล์จริง)
  with old as (
    update transactions set return_photo_url = '', return_photo_path = '',
      return_photo_deleted_at = now()
    where return_photo_path <> '' and coalesce(returned_at, updated_at) < now() - make_interval(days => keep)
    returning return_photo_path as path
  )
  insert into storage_delete_queue (bucket, path, reason)
  select 'return-photos', path, 'เก็บครบ ' || keep || ' วัน' from old;
  get diagnostics n = row_count;
  report := report || ('รูปหมดอายุ: ' || n || ' รูป');

  -- รูปที่อัปแล้วแต่ไม่ได้กดยืนยันการคืน (ทิ้งกลางทาง) ลบด้วย
  insert into storage_delete_queue (bucket, path, reason)
  select o.bucket_id, o.name, 'อัปแล้วไม่ได้ใช้'
  from storage.objects o
  join upload_tickets k on k.ticket = split_part(o.name, '/', 1)
  where o.bucket_id in ('return-photos', 'item-photos')
    and k.expires_at < now() - interval '1 day'
    and o.name not in (select return_photo_path from transactions where return_photo_path <> ''
                       union all select photo_path from items where photo_path <> '');

  -- 4. ล้างของหมดอายุ
  delete from sessions where revoked or expires_at < now();
  delete from idempotency where created_at < now() - interval '1 day';
  delete from pending_returns where created_at < now() - interval '1 day';
  delete from upload_tickets where expires_at < now() - interval '1 day';
  delete from audit_log where "timestamp" < now() - make_interval(days => cfg_int('audit_retention_days', 365));

  -- 5. กระทบยอด (ไม่แก้ให้เอง — ครูกดแก้จากแดชบอร์ด)
  rec := reconcile_stock(false);
  delete from reconcile_reports;
  if jsonb_array_length(rec->'mismatches') > 0 then
    insert into reconcile_reports (mismatches) values (rec->'mismatches');
  end if;
  report := report || ('กระทบยอด: พบไม่ตรง ' || jsonb_array_length(rec->'mismatches') || ' รายการ');

  return array_to_string(report, E'\n');
end $$;

/** เรียก Edge Function ให้ลบไฟล์ในคิว (pg_net ยิงแบบไม่รอผล) */
create or replace function call_storage_cleanup() returns void
language plpgsql security definer set search_path = public, extensions as $$
begin
  if cfg_text('project_url') = '' or not exists (select 1 from storage_delete_queue) then
    return;
  end if;
  perform net.http_post(
    url := rtrim(cfg_text('project_url'), '/') || '/functions/v1/storage-cleanup',
    body := '{}'::jsonb,
    headers := '{"Content-Type": "application/json"}'::jsonb);
end $$;


-- ---------- ตั้งเวลา ----------
create extension if not exists pg_cron with schema pg_catalog;
create extension if not exists pg_net with schema extensions;

-- 18:00 UTC = 01:00 น. เวลาไทย
select cron.schedule('eborrow-nightly', '0 18 * * *',
  'select public.nightly_maintenance(); select public.call_storage_cleanup();');
