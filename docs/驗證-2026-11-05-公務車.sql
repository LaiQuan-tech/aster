-- 2026-11-05 公務車管理（migration 0085 ＝ sql/0075）套用後驗證。唯讀＋交易內實測（最後 ROLLBACK，不留任何資料）。
-- 每一段回一張表；ok 欄全為 true 才算通過。

-- 1. 8 張表存在且 RLS 開啟；7 張掛 audit_all（vehicle_reminder_log 刻意不掛）
SELECT c.relname AS table_name,
       c.relrowsecurity AS rls_on,
       EXISTS (SELECT 1 FROM pg_trigger t WHERE t.tgrelid = c.oid AND t.tgname = 'audit_all' AND NOT t.tgisinternal) AS has_audit_all,
       (c.relrowsecurity AND (c.relname = 'vehicle_reminder_log'
          OR EXISTS (SELECT 1 FROM pg_trigger t WHERE t.tgrelid = c.oid AND t.tgname = 'audit_all' AND NOT t.tgisinternal))) AS ok
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname = 'public'
   AND c.relname IN ('vehicles','vehicle_maintenance_logs','vehicle_bookings','vehicle_trips',
                     'vehicle_trip_costs','vehicle_trip_photos','vehicle_reminder_log','vehicle_settings')
 ORDER BY c.relname;

SELECT count(*) = 8 AS ok, count(*) AS vehicle_tables
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname = 'public' AND c.relkind = 'r'
   AND c.relname IN ('vehicles','vehicle_maintenance_logs','vehicle_bookings','vehicle_trips',
                     'vehicle_trip_costs','vehicle_trip_photos','vehicle_reminder_log','vehicle_settings');

-- 2. 時段防重疊 exclusion constraint、簽核同步 trigger 存在
SELECT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'vehicle_bookings_no_overlap' AND contype = 'x') AS ok,
       'vehicle_bookings_no_overlap (exclusion)' AS item
UNION ALL
SELECT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'vehicle_booking_sync' AND NOT tgisinternal), 'trigger vehicle_booking_sync on leave_requests'
UNION ALL
SELECT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'btree_gist'), 'extension btree_gist';

-- 6. bucket vehicle-photos 存在且 private
SELECT EXISTS (SELECT 1 FROM storage.buckets WHERE id = 'vehicle-photos' AND public = false) AS ok, 'bucket vehicle-photos private' AS item;

-- 3～5. 交易內實測（ROLLBACK）
BEGIN;
CREATE TEMP TABLE _veh_check (seq serial, item text, ok boolean, detail text) ON COMMIT DROP;
DO $$
DECLARE
  t uuid; e uuid; v uuid; lr1 uuid; lr2 uuid; b1 uuid; b2 uuid; tr uuid;
  base timestamptz := '2030-01-07 10:00+08';
  got text;
BEGIN
  INSERT INTO public.tenants (name) VALUES ('驗證用租戶（會 ROLLBACK）') RETURNING id INTO t;
  INSERT INTO public.employees (tenant_id, name) VALUES (t, '驗證用員工') RETURNING id INTO e;
  INSERT INTO public.vehicles (tenant_id, plate_no, model) VALUES (t, 'TEST-0001', '驗證車') RETURNING id INTO v;

  -- 3a. 同一車兩筆重疊 pending → 第二筆 23P01
  INSERT INTO public.vehicle_bookings (tenant_id, vehicle_id, employee_id, start_at, end_at, purpose)
    VALUES (t, v, e, base, base + interval '2 hours', '驗證') RETURNING id INTO b1;
  BEGIN
    INSERT INTO public.vehicle_bookings (tenant_id, vehicle_id, employee_id, start_at, end_at, purpose)
      VALUES (t, v, e, base + interval '1 hour', base + interval '3 hours', '驗證');
    INSERT INTO _veh_check (item, ok, detail) VALUES ('重疊 pending 被擋（23P01）', false, '第二筆竟然插入成功');
  EXCEPTION WHEN exclusion_violation THEN
    INSERT INTO _veh_check (item, ok, detail) VALUES ('重疊 pending 被擋（23P01）', true, SQLSTATE);
  END;

  -- 3b. 半開區間：[10:00,12:00) 與 [12:00,14:00) 不衝突
  BEGIN
    INSERT INTO public.vehicle_bookings (tenant_id, vehicle_id, employee_id, start_at, end_at, purpose, status)
      VALUES (t, v, e, base + interval '2 hours', base + interval '4 hours', '驗證', 'cancelled');
    INSERT INTO public.vehicle_bookings (tenant_id, vehicle_id, employee_id, start_at, end_at, purpose)
      VALUES (t, v, e, base + interval '2 hours', base + interval '4 hours', '驗證') RETURNING id INTO b2;
    INSERT INTO _veh_check (item, ok, detail) VALUES ('首尾相接不衝突（半開區間）', true, null);
  EXCEPTION WHEN OTHERS THEN
    INSERT INTO _veh_check (item, ok, detail) VALUES ('首尾相接不衝突（半開區間）', false, SQLSTATE || ' ' || SQLERRM);
  END;

  -- 3c. 第一筆改 cancelled 後，同時段可再預約
  UPDATE public.vehicle_bookings SET status = 'cancelled' WHERE id = b1;
  BEGIN
    INSERT INTO public.vehicle_bookings (tenant_id, vehicle_id, employee_id, start_at, end_at, purpose)
      VALUES (t, v, e, base + interval '1 hour', base + interval '2 hours', '驗證');
    INSERT INTO _veh_check (item, ok, detail) VALUES ('取消後同時段可再預約', true, null);
  EXCEPTION WHEN OTHERS THEN
    INSERT INTO _veh_check (item, ok, detail) VALUES ('取消後同時段可再預約', false, SQLSTATE || ' ' || SQLERRM);
  END;

  -- 4. trigger：leave_request 核准 → booking approved；軟刪 → cancelled
  INSERT INTO public.leave_requests (tenant_id, employee_id, kind, start_at, end_at, status, current_step)
    VALUES (t, e, 'vehicle_booking', base + interval '2 hours', base + interval '4 hours', 'pending', 1) RETURNING id INTO lr1;
  UPDATE public.vehicle_bookings SET request_id = lr1 WHERE id = b2;
  UPDATE public.leave_requests SET status = 'approved' WHERE id = lr1;
  SELECT status INTO got FROM public.vehicle_bookings WHERE id = b2;
  INSERT INTO _veh_check (item, ok, detail) VALUES ('核准 → 預約 approved', got = 'approved', got);

  INSERT INTO public.vehicle_bookings (tenant_id, vehicle_id, employee_id, start_at, end_at, purpose)
    VALUES (t, v, e, base + interval '1 day', base + interval '1 day 2 hours', '驗證') RETURNING id INTO b1;
  INSERT INTO public.leave_requests (tenant_id, employee_id, kind, start_at, end_at, status, current_step)
    VALUES (t, e, 'vehicle_booking', base + interval '1 day', base + interval '1 day 2 hours', 'pending', 1) RETURNING id INTO lr2;
  UPDATE public.vehicle_bookings SET request_id = lr2 WHERE id = b1;
  UPDATE public.leave_requests SET deleted_at = now(), delete_reason = '驗證' WHERE id = lr2;
  SELECT status INTO got FROM public.vehicle_bookings WHERE id = b1;
  INSERT INTO _veh_check (item, ok, detail) VALUES ('軟刪申請單 → 預約 cancelled', got = 'cancelled', got);

  -- 5. 還車里程 < 出車里程 → 23514
  INSERT INTO public.vehicle_trips (tenant_id, vehicle_id, booking_id, employee_id, start_odometer)
    VALUES (t, v, b2, e, 1000) RETURNING id INTO tr;
  BEGIN
    UPDATE public.vehicle_trips SET returned_at = now(), end_odometer = 999, condition_status = 'ok' WHERE id = tr;
    INSERT INTO _veh_check (item, ok, detail) VALUES ('還車里程 < 出車里程被擋（23514）', false, '竟然更新成功');
  EXCEPTION WHEN check_violation THEN
    INSERT INTO _veh_check (item, ok, detail) VALUES ('還車里程 < 出車里程被擋（23514）', true, SQLSTATE);
  END;
  UPDATE public.vehicle_trips SET returned_at = now(), end_odometer = 1042, condition_status = 'ok' WHERE id = tr;
  SELECT distance_km::text INTO got FROM public.vehicle_trips WHERE id = tr;
  INSERT INTO _veh_check (item, ok, detail) VALUES ('distance_km 自動計算（42）', got = '42', got);
END $$;
SELECT item, ok, detail FROM _veh_check ORDER BY seq;
ROLLBACK;
