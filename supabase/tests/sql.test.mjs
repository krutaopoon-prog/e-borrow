// ทดสอบ SQL ทั้งหมดด้วย PGlite (Postgres จำลองในเครื่อง) — รัน: cd supabase/tests && npm install && npm test
// ส่วนที่มีเฉพาะบน Supabase (storage, pg_cron, pg_net) ถูกจำลองด้วยตารางเปล่า
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = process.argv[2] || fileURLToPath(new URL('..', import.meta.url));
const db = new PGlite({ extensions: { pgcrypto } });

// ---- stub ส่วนที่มีเฉพาะบน Supabase ----
await db.exec(`
  create role anon; create role authenticated;
  create schema extensions;
  create schema storage;
  create table storage.buckets (id text primary key, name text, public boolean,
    file_size_limit bigint, allowed_mime_types text[]);
  create table storage.objects (id bigserial, bucket_id text, name text,
    created_at timestamptz default now(), metadata jsonb);
  alter table storage.objects enable row level security;
  create schema cron;
  create table cron.jobs (name text, sched text, cmd text);
  create function cron.schedule(n text, s text, c text) returns bigint language sql as
    $$ insert into cron.jobs values (n, s, c); select 1::bigint $$;
  create schema net;
  create table net.calls (url text);
  create function net.http_post(url text, body jsonb, headers jsonb) returns bigint language sql as
    $$ insert into net.calls values (url); select 1::bigint $$;
`);

const files = fs.readdirSync(path.join(DIR, 'migrations')).sort();
for (const f of files) {
  let sql = fs.readFileSync(path.join(DIR, 'migrations', f), 'utf8');
  sql = sql.replace(/^create extension if not exists pg_(cron|net).*$/gm, '');
  try { await db.exec(sql); } catch (e) { console.error('FAIL in', f, e.message); process.exit(1); }
  console.log('ok', f);
}
await db.exec(fs.readFileSync(path.join(DIR, 'seed.sql'), 'utf8'));
await db.exec(`update config set value = 'https://test.supabase.co' where key = 'project_url'`);
console.log('ok seed');

let n = 0;
const rid = () => 'req-' + (++n);
async function api(action, payload = {}, token = null, requestId) {
  const write = !['ping','getPublicConfig','getCatalog','listItems','getItem','validateSession',
    'myTransactions','getTransaction','validateCart','adminPendingStudents','adminListStudents',
    'adminPendingRequests','adminDashboard','adminGetConfig','adminReconcile'].includes(action);
  const r = await db.query('select api($1, $2, $3, $4) as r',
    [action, token, payload, write ? (requestId || rid()) : null]);
  return r.rows[0].r;
}
let fails = 0;
function check(name, cond, extra) {
  console.log((cond ? '  PASS ' : '  FAIL ') + name + (cond ? '' : ' → ' + JSON.stringify(extra)));
  if (!cond) fails++;
}
const ok = (r) => r.ok ? r.data : (() => { throw new Error(JSON.stringify(r.error)); })();
const q1 = async (sql, p) => (await db.query(sql, p)).rows[0];

// ---- 1. ping + admin ----
check('ping', (await api('ping')).data?.pong === true);
console.log(' ', (await q1(`select create_admin('000000', 'ครู', '123456') as m`)).m);
let r = await api('login', { student_id: '000000', pin: '123456' });
check('admin login', r.ok, r);
const admin = r.data.token;

// ---- auth rules ----
r = await api('register', { student_id: '6512345', full_name: 'นักเรียน ก', level: 'ปวช.1', department: 'อิเล็ก', pin: '1234' });
check('weak pin rejected', r.error?.code === 'WEAK_PIN', r);
r = await api('register', { student_id: '6512345', full_name: 'นักเรียน ก', level: 'ปวช.1', department: 'อิเล็ก', pin: '4826' });
check('register', r.ok, r);
r = await api('register', { student_id: '6512345', full_name: 'x', level: 'a', department: 'b', pin: '4826' });
check('duplicate id', r.error?.code === 'DUPLICATE_STUDENT_ID', r);
r = await api('login', { student_id: '6512345', pin: '4826' });
check('pending blocked', r.error?.code === 'ACCOUNT_PENDING', r);
r = await api('adminApproveStudent', { student_id: '6512345' }, admin);
check('approve student', r.ok, r);
r = await api('adminApproveStudent', { student_id: '6512345' }, 'bogus');
check('bad token', r.error?.code === 'SESSION_EXPIRED', r);
for (let i = 0; i < 5; i++) r = await api('login', { student_id: '6512345', pin: '9999' });
check('wrong pin counted → locked', (await api('login', { student_id: '6512345', pin: '4826' })).error?.code === 'ACCOUNT_LOCKED');
await db.exec(`update students set locked_until = null where student_id = '6512345'`);
r = await api('login', { student_id: '6512345', pin: '4826' });
check('student login', r.ok, r);
const stu = r.data.token;
r = await api('adminDashboard', {}, stu);
check('student cannot call admin', r.error?.code === 'FORBIDDEN', r);

// ---- 2. catalog ----
ok(await api('adminUpsertCategory', { category: { name_th: 'เครื่องมือวัด', icon: '📏' } }, admin));
const meter = ok(await api('adminUpsertItem', { item: { name_th: 'มัลติมิเตอร์', category_id: 'CAT-01', total_qty: 5, storage_location: 'ตู้ A', min_qty: 1 } }, admin)).item_id;
const resist = ok(await api('adminUpsertItem', { item: { name_th: 'ตัวต้านทาน', total_qty: 100, is_consumable: true, unit: 'ตัว' } }, admin)).item_id;
check('item ids', meter === 'ITM-0001' && resist === 'ITM-0002', [meter, resist]);
r = await api('getCatalog');
check('catalog public hides storage_location', r.ok && r.data.items.length === 2 && r.data.items[0].storage_location === undefined, r);
r = await api('getCatalog', {}, admin);
check('catalog admin sees storage_location', r.data.items[0].storage_location === 'ตู้ A', r.data.items[0]);
ok(await api('adminUpsertItem', { item: { item_id: meter, name_th: 'มัลติมิเตอร์ดิจิตอล', total_qty: 5 } }, admin));
check('edit keeps storage_location', (await q1(`select storage_location, min_qty from items where item_id=$1`, [meter])).storage_location === 'ตู้ A');

// ---- 3. borrow flow ----
r = await api('submitRequest', { lines: [{ item_id: meter, qty: 6 }] }, stu);
check('insufficient stock', r.error?.code === 'INSUFFICIENT_STOCK' && r.error.message_th.includes('เหลือ 5'), r);
const req1 = rid();
r = await api('submitRequest', { lines: [{ item_id: meter, qty: 2 }, { item_id: meter, qty: 1 }, { item_id: resist, qty: 10 }] }, stu, req1);
check('submit', r.ok && r.data.status === 'REQUESTED', r);
const txn = r.data.txn_id;
const again = await api('submitRequest', { lines: [{ item_id: meter, qty: 3 }] }, stu, req1);
check('idempotent replay', again.ok && again.data.txn_id === txn, again);
check('only one txn', (await q1(`select count(*)::int c from transactions`)).c === 1);
let it = await q1(`select * from items where item_id=$1`, [meter]);
check('reserved 3', it.available_qty === 2 && it.reserved_qty === 3, it);

r = await api('adminPendingRequests', {}, admin);
check('pending + pick list', r.ok && r.data.counts.awaiting_approval === 1 && r.data.pick_list.length === 2, r.data?.counts);
r = await api('adminIssueTransaction', { txn_id: txn }, admin);
check('issue', r.ok && r.data.status === 'IN_USE', r);
it = await q1(`select * from items where item_id=$1`, [meter]);
check('issued: out 3', it.available_qty === 2 && it.reserved_qty === 0 && it.out_qty === 3 && it.total_qty === 5, it);
it = await q1(`select * from items where item_id=$1`, [resist]);
check('consumable: total 90', it.total_qty === 90 && it.available_qty === 90 && it.reserved_qty === 0, it);

// ---- return with photo ----
r = await api('getTransaction', { txn_id: txn }, stu);
const line = r.data.transaction.lines.find(l => l.item_id === meter);
r = await api('initiateReturn', { txn_id: txn, lines: [{ line_id: line.line_id, qty_returned: 2, qty_lost: 1 }] }, stu);
check('initiate return', r.ok, r);
const { return_id, upload_token } = r.data;
r = await api('finalizeReturn', { return_id, upload_token }, stu);
check('photo required', r.error?.code === 'PHOTO_REQUIRED', r);
check('storage policy allows ticket', (await q1(`select storage_ticket_ok('return-photos', $1 || '/x.webp') ok`, [upload_token])).ok === true);
check('storage policy rejects random', (await q1(`select storage_ticket_ok('return-photos', 'nope/x.webp') ok`)).ok === false);
await db.query(`insert into storage.objects (bucket_id, name, metadata) values ('return-photos', $1, '{"size": 52000}')`, [upload_token + '/' + txn + '.webp']);
r = await api('finalizeReturn', { return_id, upload_token }, stu);
check('finalize', r.ok && r.data.status === 'RETURNED' && r.data.photo_url.startsWith('https://test.supabase.co/storage/v1/object/public/return-photos/'), r);
it = await q1(`select * from items where item_id=$1`, [meter]);
check('returned 2 lost 1', it.available_qty === 4 && it.out_qty === 0 && it.total_qty === 4, it);
let s = await q1(`select active_loan_count from students where student_id='6512345'`);
check('loan count back to 0', s.active_loan_count === 0, s);
r = await api('reconcile' === 'x' ? '' : 'adminReconcile', {}, admin);
check('reconcile clean', r.ok && r.data.mismatches.length === 0, r);

// ---- cancel & reject ----
const t2 = ok(await api('submitRequest', { lines: [{ item_id: meter, qty: 1 }] }, stu)).txn_id;
r = await api('cancelRequest', { txn_id: t2 }, stu);
check('cancel', r.ok, r);
check('cancel unreserved', (await q1(`select available_qty from items where item_id=$1`, [meter])).available_qty === 4);
const t3 = ok(await api('submitRequest', { lines: [{ item_id: meter, qty: 2 }] }, stu)).txn_id;
r = await api('adminApproveRequest', { txn_id: t3, line_overrides: [{ line_id: t3 + '-L1', qty_approved: 1 }] }, admin);
check('approve reduced', r.ok && (await q1(`select available_qty a, reserved_qty r from items where item_id=$1`, [meter])).a === 3, r);
r = await api('adminConfirmReturn', { txn_id: t3 }, admin);
check('confirm return on non-issued fails', r.error?.code === 'INVALID_STATE', r);
ok(await api('adminIssueTransaction', { txn_id: t3 }, admin));
r = await api('adminConfirmReturn', { txn_id: t3 }, admin);
check('admin confirm return', r.ok && r.data.status === 'RETURNED', r);

// ---- my transactions / dashboard ----
r = await api('myTransactions', { status_filter: 'closed' }, stu);
check('my transactions', r.ok && r.data.transactions.length === 3, r.data?.transactions?.length);
r = await api('adminDashboard', {}, admin);
check('dashboard', r.ok && r.data.stats.storage_mb === 0.1, r.data?.stats);

// ---- adjust stock ----
r = await api('adminAdjustStock', { item_id: resist, delta_total: 50, reason: 'ซื้อเพิ่ม' }, admin);
check('adjust', r.ok && r.data.total_qty === 140, r);
r = await api('adminAdjustStock', { item_id: resist, delta_total: -500, reason: 'x' }, admin);
check('adjust negative refused', r.error?.code === 'BAD_REQUEST', r);

// ---- overdue + quota ----
const t4 = ok(await api('submitRequest', { lines: [{ item_id: meter, qty: 1 }] }, stu)).txn_id;
ok(await api('adminIssueTransaction', { txn_id: t4 }, admin));
await db.query(`update transactions set due_at = now() - interval '1 day' where txn_id=$1`, [t4]);
console.log('  ' + (await q1(`select nightly_maintenance() m`)).m.replace(/\n/g, ' | '));
check('marked overdue', (await q1(`select status from transactions where txn_id=$1`, [t4])).status === 'OVERDUE');
r = await api('submitRequest', { lines: [{ item_id: meter, qty: 1 }] }, stu);
check('blocked by overdue', r.error?.code === 'HAS_OVERDUE', r);
ok(await api('adminConfirmReturn', { txn_id: t4 }, admin));
s = await q1(`select overdue_count, active_loan_count from students where student_id='6512345'`);
check('overdue cleared after return', s.overdue_count === 0 && s.active_loan_count === 0, s);

// ---- photo retention ----
await db.exec(`update transactions set returned_at = now() - interval '121 days' where return_photo_path <> ''`);
await db.query(`select nightly_maintenance()`);
const q = await q1(`select count(*)::int c from storage_delete_queue`);
check('old photo queued', q.c === 1, q);
check('photo url cleared', (await q1(`select return_photo_url u from transactions where txn_id=$1`, [txn])).u === '');
await db.query(`select call_storage_cleanup()`);
check('cleanup function called', (await q1(`select url from net.calls`)).url === 'https://test.supabase.co/functions/v1/storage-cleanup');

// ---- expiry of stale requests ----
const t5 = ok(await api('submitRequest', { lines: [{ item_id: meter, qty: 1 }] }, stu)).txn_id;
await db.query(`update transactions set requested_at = now() - interval '3 days' where txn_id=$1`, [t5]);
await db.query(`select nightly_maintenance()`);
check('stale expired', (await q1(`select status from transactions where txn_id=$1`, [t5])).status === 'EXPIRED');
r = await api('adminReconcile', {}, admin);
check('final reconcile clean', r.data.mismatches.length === 0, r.data);

// ---- change pin / logout ----
r = await api('changePin', { old_pin: '4826', new_pin: '5917' }, stu);
check('change pin', r.ok, r);
check('session still valid', (await api('validateSession', {}, stu)).ok);
ok(await api('logout', {}, stu));
check('logged out', (await api('validateSession', {}, stu)).error?.code === 'SESSION_EXPIRED');

// ---- privileges ----
const grants = await db.query(`select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and has_function_privilege('anon', p.oid, 'execute') order by 1`);
check('anon can execute only api + storage_ticket_ok', grants.rows.map(r => r.proname).join(',') === 'api,storage_ticket_ok', grants.rows);
const tbl = await db.query(`select c.relname from pg_class c join pg_namespace n on n.oid=c.relnamespace
  where n.nspname='public' and c.relkind='r' and has_table_privilege('anon', c.oid, 'select')`);
check('anon has no table access', tbl.rows.length === 0, tbl.rows);
const audit = await q1(`select count(*)::int c, sum((detail_json like '%4826%')::int)::int leaked from audit_log`);
check('audit has rows, no PIN leaked', audit.c > 10 && audit.leaked === 0, audit);

console.log(fails ? `\n${fails} FAILED` : '\nALL PASSED');
process.exit(fails ? 1 : 0);
