// storage-cleanup — ลบไฟล์รูปที่อยู่ในคิว storage_delete_queue
//
// ทำไมต้องมี: Postgres ลบไฟล์ใน Storage ตรงๆ ไม่ได้ (ลบแถวใน storage.objects
// จะทิ้งไฟล์จริงค้างไว้และยังกินพื้นที่) ต้องลบผ่าน Storage API เท่านั้น
//
// ใครเรียก: pg_cron ทุกคืนหลัง nightly_maintenance() (ดู 009_cron.sql)
// ปิด "Enforce JWT verification" ได้ปลอดภัย — ฟังก์ชันนี้ทำได้แค่ลบไฟล์ที่ระบบสั่งไว้ในคิว

import { createClient } from 'npm:@supabase/supabase-js@2.45.4';

Deno.serve(async () => {
  const sb = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  );

  let deleted = 0;
  // รอบละ 100 ไฟล์ สูงสุด 20 รอบ (2,000 ไฟล์/คืน) — เหลือก็ไว้คืนถัดไป
  for (let round = 0; round < 20; round++) {
    const { data: rows, error } = await sb
      .from('storage_delete_queue')
      .select('id, bucket, path')
      .order('id')
      .limit(100);
    if (error) return Response.json({ ok: false, error: error.message, deleted }, { status: 500 });
    if (!rows.length) break;

    const byBucket = new Map<string, string[]>();
    for (const r of rows) {
      byBucket.set(r.bucket, [...(byBucket.get(r.bucket) ?? []), r.path]);
    }
    for (const [bucket, paths] of byBucket) {
      // ไฟล์ที่ไม่มีอยู่แล้วไม่ถือเป็น error — ลบออกจากคิวได้เลย
      const { error: rmErr } = await sb.storage.from(bucket).remove(paths);
      if (rmErr) return Response.json({ ok: false, error: rmErr.message, deleted }, { status: 500 });
    }

    const { error: delErr } = await sb
      .from('storage_delete_queue')
      .delete()
      .in('id', rows.map((r) => r.id));
    if (delErr) return Response.json({ ok: false, error: delErr.message, deleted }, { status: 500 });
    deleted += rows.length;
  }

  return Response.json({ ok: true, deleted });
});
