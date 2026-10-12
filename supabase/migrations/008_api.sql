-- =============================================================
-- 008_api.sql — ทางเข้าเดียวของหน้าเว็บ (แทน doPost ของ Apps Script)
--
-- หน้าเว็บเรียก: POST {SUPABASE_URL}/rest/v1/rpc/api
--                body {action, token, payload, request_id}
-- คืน envelope เดิมทุกประการ: {ok, data, serverTime} หรือ {ok:false, error:{code, message_th, details}}
--
-- ทุก action ที่ขึ้นต้นด้วย admin ถูกบังคับตรวจสิทธิ์ครูที่นี่ เผื่อ handler ลืมเช็กเอง
-- =============================================================

create or replace function api(action text, token text default null, payload jsonb default '{}',
                               request_id text default null)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
-- รอล็อกแถวนานสุด 2 วินาที แล้วตอบ SYSTEM_BUSY ให้หน้าเว็บลองใหม่เอง
-- (ต้องน้อยกว่า statement_timeout 3 วินาทีของ anon บน Supabase ไม่งั้นโดนตัดเป็น HTTP 500 แทน)
set lock_timeout = '2s'
as $$
declare
  public_actions text[] := array['ping', 'getPublicConfig', 'register', 'login',
                                 'getCatalog', 'listItems', 'getItem'];
  -- action ที่เปลี่ยนข้อมูล — ต้องมี requestId เพื่อกันส่งซ้ำ (ไวไฟวิทยาลัยส่งซ้ำแน่นอน)
  write_actions text[] := array['register', 'login', 'logout', 'changePin',
    'submitRequest', 'cancelRequest', 'initiateReturn', 'finalizeReturn',
    'adminApproveStudent', 'adminResetPin', 'adminApproveRequest', 'adminRejectRequest',
    'adminIssueTransaction', 'adminConfirmReturn', 'adminMarkLost',
    'adminUpsertItem', 'adminCreateItemUploadTicket', 'adminUploadItemPhoto',
    'adminAdjustStock', 'adminUpsertCategory', 'adminSetConfig'];
  p        jsonb := coalesce(payload, '{}'::jsonb);
  sess     jsonb;
  data     jsonb;
  envelope jsonb;
  is_write boolean := action = any (write_actions);
  v_code   text;
  v_msg    text;
  v_hint   text;
  v_state  text;
  cached   jsonb;
begin
  if is_write then
    if coalesce(request_id, '') = '' then
      return jsonb_build_object('ok', false, 'serverTime', iso(now()), 'error',
        jsonb_build_object('code', 'BAD_REQUEST', 'message_th', 'ขาด requestId', 'details', null));
    end if;
    -- requestId เดิมส่งมาพร้อมกันสองครั้ง → ครั้งที่สองรอครั้งแรกเสร็จแล้วได้คำตอบเดียวกัน
    perform pg_advisory_xact_lock(hashtext('idem:' || request_id));
    select response into cached from idempotency i where i.request_id = api.request_id;
    if found then return cached; end if;
  end if;

  begin
    if action like 'admin%' then
      sess := require_auth(token);
      if sess->>'role' <> 'ADMIN' then perform app_error('FORBIDDEN'); end if;
    elsif not (action = any (public_actions)) then
      sess := require_auth(token);
    elsif coalesce(token, '') <> '' then
      -- action สาธารณะแต่มี token (เช่นครูเปิดแคตตาล็อก) — รู้ว่าเป็นใครถ้าทำได้ ไม่บังคับ
      begin
        sess := require_auth(token);
      exception when others then
        sess := null;
      end;
    end if;

    data := case action
      when 'ping'                 then jsonb_build_object('pong', true, 'version', '2.0.0',
                                                          'timeZone', 'Asia/Bangkok', 'backend', 'supabase')
      when 'getPublicConfig'      then h_get_public_config(p, sess)
      when 'register'             then h_register(p)
      when 'login'                then h_login(p)
      when 'validateSession'      then h_validate_session(p, sess)
      when 'logout'               then h_logout(p, sess)
      when 'changePin'            then h_change_pin(p, sess)
      when 'getCatalog'           then h_get_catalog(p, sess)
      when 'listItems'            then h_list_items(p, sess)
      when 'getItem'              then h_get_item(p, sess)
      when 'validateCart'         then h_validate_cart(p, sess)
      when 'submitRequest'        then h_submit_request(p, sess)
      when 'cancelRequest'        then h_cancel_request(p, sess)
      when 'myTransactions'       then h_my_transactions(p, sess)
      when 'getTransaction'       then h_get_transaction(p, sess)
      when 'initiateReturn'       then h_initiate_return(p, sess)
      when 'finalizeReturn'       then h_finalize_return(p, sess)
      when 'adminPendingStudents' then h_admin_pending_students(p, sess)
      when 'adminApproveStudent'  then h_admin_approve_student(p, sess)
      when 'adminListStudents'    then h_admin_list_students(p, sess)
      when 'adminResetPin'        then h_admin_reset_pin(p, sess)
      when 'adminPendingRequests' then h_admin_pending_requests(p, sess)
      when 'adminApproveRequest'  then h_admin_approve_request(p, sess)
      when 'adminRejectRequest'   then h_admin_reject_request(p, sess)
      when 'adminIssueTransaction' then h_admin_issue_transaction(p, sess)
      when 'adminConfirmReturn'   then h_admin_confirm_return(p, sess)
      when 'adminMarkLost'        then h_admin_mark_lost(p, sess)
      when 'adminDashboard'       then h_admin_dashboard(p, sess)
      when 'adminUpsertItem'      then h_admin_upsert_item(p, sess)
      when 'adminCreateItemUploadTicket' then h_admin_create_item_upload_ticket(p, sess)
      when 'adminUploadItemPhoto' then h_admin_upload_item_photo(p, sess)
      when 'adminAdjustStock'     then h_admin_adjust_stock(p, sess)
      when 'adminUpsertCategory'  then h_admin_upsert_category(p, sess)
      when 'adminGetConfig'       then h_admin_get_config(p, sess)
      when 'adminSetConfig'       then h_admin_set_config(p, sess)
      when 'adminReconcile'       then h_admin_reconcile(p, sess)
    end;

    if data is null then
      perform app_error('BAD_REQUEST', 'ไม่รู้จักคำสั่ง: ' || coalesce(action, ''));
    end if;

  exception
    when sqlstate 'P0001' then
      -- ข้อผิดพลาดที่ตั้งใจ (app_error) — ทุกอย่างในบล็อกนี้ถูก rollback แล้ว
      get stacked diagnostics v_code = message_text, v_msg = pg_exception_detail, v_hint = pg_exception_hint;
      data := jsonb_build_object('__error', v_code, '__message', v_msg,
                                 '__details', case when v_hint <> '' then v_hint::jsonb end);
    when lock_not_available or deadlock_detected or serialization_failure then
      data := jsonb_build_object('__error', 'SYSTEM_BUSY');
    when others then
      get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text;
      raise warning 'api % failed: [%] %', action, v_state, v_msg;
      data := jsonb_build_object('__error', 'INTERNAL_ERROR', '__log', v_state || ' ' || v_msg);
  end;

  if data ? '__error' then
    v_code := data->>'__error';
    envelope := jsonb_build_object('ok', false, 'serverTime', iso(now()), 'error', jsonb_build_object(
      'code', v_code,
      'message_th', coalesce(data->>'__message',
                             (select m.message_th from error_messages m where m.code = v_code),
                             'เกิดข้อผิดพลาด'),
      'details', data->'__details'));
    -- บันทึกทุกครั้งที่ถูกปฏิเสธ — นี่คือสิ่งที่บอกว่ามีคนพยายามเดา PIN
    perform audit(sess->>'student_id', sess->>'role', action,
      case when v_code in ('FORBIDDEN', 'UNAUTHENTICATED', 'INVALID_CREDENTIALS') then 'DENIED' else 'ERROR' end,
      jsonb_build_object('code', v_code, 'detail', coalesce(data->>'__log', data->>'__message')));
    -- error ไม่เก็บใน idempotency — ให้ลองใหม่ได้ (เช่นของหมดแล้วครูเติมสต็อก)
    return envelope;
  end if;

  envelope := jsonb_build_object('ok', true, 'data', data, 'serverTime', iso(now()));
  if is_write then
    insert into idempotency (request_id, response) values (api.request_id, envelope)
    on conflict on constraint idempotency_pkey do nothing;
  end if;
  if sess is not null and action not in ('getCatalog', 'getItem', 'listItems', 'getPublicConfig') then
    perform audit(sess->>'student_id', sess->>'role', action, 'OK', p);
  end if;
  return envelope;
end $$;
