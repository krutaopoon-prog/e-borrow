-- =============================================================
-- 010_storage.sql — ที่เก็บรูป (Supabase Storage ฟรี 1 GB)
--
-- งบพื้นที่: รูปถูกย่อเหลือ ~50 KB ที่หน้าเว็บ (js/image.js)
--           + ลบรูปตอนคืนที่อายุเกิน 4 เดือน (009_cron.sql)
--           ห้อง 30 คนใช้ราว 50 MB → รองรับได้ ~15 ห้องพร้อมกัน
--
-- ใครอัปได้: เฉพาะคนที่ถือ "ตั๋ว" (upload_tickets) ที่ api() ออกให้
-- หลังตรวจสิทธิ์แล้ว — path ต้องขึ้นต้นด้วย {ticket}/ และตั๋วยังไม่หมดอายุ
-- =============================================================

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types) values
  ('return-photos', 'return-photos', true, 307200, array['image/webp', 'image/jpeg']),
  ('item-photos',   'item-photos',   true, 307200, array['image/webp', 'image/jpeg'])
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,      -- 300 KB กันคนข้ามการย่อรูป
  allowed_mime_types = excluded.allowed_mime_types;

create or replace function storage_ticket_ok(p_bucket text, p_name text) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
      select 1 from upload_tickets t
      where t.ticket = split_part(p_name, '/', 1) and t.bucket = p_bucket
        and not t.used and t.expires_at > now())
    -- ตั๋วละไม่เกิน 3 ไฟล์ (เผื่อถ่ายใหม่) กันคนเอาตั๋วไปอัปไฟล์รัวๆ
    and (select count(*) from storage.objects o
         where o.bucket_id = p_bucket and o.name like split_part(p_name, '/', 1) || '/%') < 3
$$;

drop policy if exists "eborrow upload with ticket" on storage.objects;
create policy "eborrow upload with ticket" on storage.objects
  for insert to anon, authenticated
  with check (bucket_id in ('return-photos', 'item-photos')
              and public.storage_ticket_ok(bucket_id, name));
