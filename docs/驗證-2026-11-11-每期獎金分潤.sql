-- 2026-11-11 專案申請單每期款獎金分潤（migration 0091 ＝ sql/0081）套用後驗證。ok 欄全為 true 才算通過。
-- 第 1 段：唯讀結構檢查（一個查詢回一張表；正式庫可在前面加 `set transaction read only;` 執行）。
-- 第 2 段：交易內實測（最後 ROLLBACK，不留任何資料；建議在 pglite（npm run db:replay）上跑，正式庫可略過）。

-- 1. 結構：兩張表存在、RLS 開、無 policy、不掛 audit_all、anon／authenticated 無表權限；欄位、約束、索引；函式權限
SELECT item, ok, detail FROM (
  SELECT 1 AS seq, '兩張表存在' AS item,
         count(*) = 2 AS ok, string_agg(c.relname, ', ' ORDER BY c.relname) AS detail
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relname IN ('project_billing_shares', 'project_billing_bonus_dates')
  UNION ALL
  SELECT 2, 'RLS 開＋無 audit_all＋無 policy',
         bool_and(c.relrowsecurity
                  AND NOT EXISTS (SELECT 1 FROM pg_trigger t WHERE t.tgrelid = c.oid AND t.tgname = 'audit_all' AND NOT t.tgisinternal)
                  AND NOT EXISTS (SELECT 1 FROM pg_policies p WHERE p.schemaname = 'public' AND p.tablename = c.relname)),
         string_agg(c.relname || ':rls=' || c.relrowsecurity::text, ', ')
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relname IN ('project_billing_shares', 'project_billing_bonus_dates')
  UNION ALL
  SELECT 3, 'anon／authenticated 沒有表權限',
         NOT bool_or(has_table_privilege(r.rolname, 'public.' || t.tbl, 'SELECT')
                     OR has_table_privilege(r.rolname, 'public.' || t.tbl, 'INSERT')
                     OR has_table_privilege(r.rolname, 'public.' || t.tbl, 'UPDATE')
                     OR has_table_privilege(r.rolname, 'public.' || t.tbl, 'DELETE')),
         NULL
    FROM (VALUES ('project_billing_shares'), ('project_billing_bonus_dates')) AS t(tbl)
    CROSS JOIN pg_roles r WHERE r.rolname IN ('anon', 'authenticated')
  UNION ALL
  SELECT 4, 'project_billing_shares 欄位',
         count(*) = 10, string_agg(column_name || ':' || data_type, ', ' ORDER BY ordinal_position)
    FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'project_billing_shares'
     AND (column_name, data_type) IN (
       ('id','uuid'), ('tenant_id','uuid'), ('project_id','uuid'), ('billing_id','uuid'), ('employee_id','uuid'),
       ('amount','numeric'), ('note','text'), ('created_by','uuid'),
       ('created_at','timestamp with time zone'), ('updated_at','timestamp with time zone'))
  UNION ALL
  SELECT 5, 'project_billing_bonus_dates 欄位',
         count(*) = 7, string_agg(column_name || ':' || data_type, ', ' ORDER BY ordinal_position)
    FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'project_billing_bonus_dates'
     AND (column_name, data_type) IN (
       ('billing_id','uuid'), ('tenant_id','uuid'), ('project_id','uuid'), ('bonus_paid_on','date'), ('created_by','uuid'),
       ('created_at','timestamp with time zone'), ('updated_at','timestamp with time zone'))
  UNION ALL
  SELECT 6, 'CHECK 約束（金額 ≥ 0、備註長度）',
         count(*) = 2, string_agg(conname, ', ' ORDER BY conname)
    FROM pg_constraint
   WHERE conrelid = 'public.project_billing_shares'::regclass AND contype = 'c'
     AND conname IN ('project_billing_shares_amount_chk', 'project_billing_shares_note_chk')
  UNION ALL
  SELECT 7, 'FK：tenant／project／billing／employee（分潤）＋billing／tenant／project（發獎金日）',
         count(*) = 7, string_agg(conrelid::regclass::text || '→' || confrelid::regclass::text, ', ' ORDER BY conrelid::regclass::text, confrelid::regclass::text)
    FROM pg_constraint
   WHERE contype = 'f' AND conrelid IN ('public.project_billing_shares'::regclass, 'public.project_billing_bonus_dates'::regclass)
  UNION ALL
  SELECT 8, '索引（一期一人唯一、tenant+project）',
         count(*) = 3, string_agg(indexname, ', ' ORDER BY indexname)
    FROM pg_indexes WHERE schemaname = 'public'
     AND indexname IN ('project_billing_shares_billing_emp_uq', 'project_billing_shares_tenant_project_idx', 'project_billing_bonus_dates_tenant_project_idx')
  UNION ALL
  SELECT 9, 'set_billing_bonus_shares：security definer＋固定 search_path＋advisory lock',
         bool_and(p.prosecdef AND array_to_string(p.proconfig, ',') LIKE '%search_path=public%'
                  AND pg_get_functiondef(p.oid) LIKE '%pg_advisory_xact_lock%'), count(*)::text
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'set_billing_bonus_shares'
  UNION ALL
  SELECT 10, '函式執行權限：只有 service_role',
         (NOT has_function_privilege('anon', 'public.set_billing_bonus_shares(uuid, uuid, uuid, date, jsonb, uuid)', 'EXECUTE')
          AND NOT has_function_privilege('authenticated', 'public.set_billing_bonus_shares(uuid, uuid, uuid, date, jsonb, uuid)', 'EXECUTE')
          AND has_function_privilege('service_role', 'public.set_billing_bonus_shares(uuid, uuid, uuid, date, jsonb, uuid)', 'EXECUTE')),
         NULL
) checks ORDER BY seq;

-- 2. 交易內實測（ROLLBACK）：函式邏輯、跨租戶、稽核摘要不含金額
BEGIN;
CREATE TEMP TABLE _pbs_check (seq serial, item text, ok boolean, detail text) ON COMMIT DROP;
DO $$
DECLARE t uuid; t2 uuid; p uuid; p2 uuid; b uuid; e1 uuid; e2 uuid; ex uuid; n int; got text;
BEGIN
  INSERT INTO public.tenants (name) VALUES ('驗證用租戶（會 ROLLBACK）') RETURNING id INTO t;
  INSERT INTO public.tenants (name) VALUES ('驗證用別租戶（會 ROLLBACK）') RETURNING id INTO t2;
  INSERT INTO public.projects (tenant_id, name) VALUES (t, '驗證用專案') RETURNING id INTO p;
  INSERT INTO public.projects (tenant_id, name) VALUES (t, '驗證用另一案') RETURNING id INTO p2;
  INSERT INTO public.project_billings (tenant_id, project_id, installment_no) VALUES (t, p, 1) RETURNING id INTO b;
  INSERT INTO public.employees (tenant_id, name, role) VALUES (t, '驗證甲', 'employee') RETURNING id INTO e1;
  INSERT INTO public.employees (tenant_id, name, role) VALUES (t, '驗證乙', 'employee') RETURNING id INTO e2;
  INSERT INTO public.employees (tenant_id, name, role) VALUES (t2, '別租戶丙', 'employee') RETURNING id INTO ex;

  n := public.set_billing_bonus_shares(t, p, b, DATE '2026-12-20',
         jsonb_build_array(jsonb_build_object('employee_id', e1, 'amount', 30000), jsonb_build_object('employee_id', e2, 'amount', 15000, 'note', ' 備註 ')), NULL);
  SELECT string_agg(amount::text || ':' || coalesce(note, '-'), ' | ' ORDER BY amount DESC) INTO got FROM public.project_billing_shares WHERE billing_id = b;
  INSERT INTO _pbs_check (item, ok, detail) VALUES ('寫入兩人', n = 2 AND got = '30000:- | 15000:備註', got);
  SELECT bonus_paid_on::text INTO got FROM public.project_billing_bonus_dates WHERE billing_id = b;
  INSERT INTO _pbs_check (item, ok, detail) VALUES ('發獎金日', got = '2026-12-20', got);

  -- 整批換掉：只剩一人；清掉發獎金日
  n := public.set_billing_bonus_shares(t, p, b, NULL, jsonb_build_array(jsonb_build_object('employee_id', e2, 'amount', 1000)), NULL);
  SELECT count(*) INTO n FROM public.project_billing_shares WHERE billing_id = b;
  INSERT INTO _pbs_check (item, ok, detail) VALUES ('整批換掉＝只剩一人', n = 1, n::text);
  SELECT count(*) INTO n FROM public.project_billing_bonus_dates WHERE billing_id = b;
  INSERT INTO _pbs_check (item, ok, detail) VALUES ('發獎金日 NULL＝清掉', n = 0, n::text);

  -- 稽核摘要：有紀錄、不含金額
  SELECT count(*) INTO n FROM public.audit_logs WHERE table_name = 'project_billing_shares' AND tenant_id = t;
  INSERT INTO _pbs_check (item, ok, detail) VALUES ('寫入有稽核摘要', n = 2, n::text);
  SELECT count(*) INTO n FROM public.audit_logs
   WHERE table_name = 'project_billing_shares' AND tenant_id = t
     AND (new_row::text LIKE '%30000%' OR new_row::text LIKE '%amount%' OR new_row ? 'shares');
  INSERT INTO _pbs_check (item, ok, detail) VALUES ('稽核不含金額', n = 0, n::text);

  -- 擋：別租戶、期別不屬此專案、員工不屬此租戶、重複員工、負數、非數字
  BEGIN
    PERFORM public.set_billing_bonus_shares(t2, p, b, NULL, '[]'::jsonb, NULL);
    INSERT INTO _pbs_check (item, ok, detail) VALUES ('別租戶被擋', false, '竟然成功');
  EXCEPTION WHEN no_data_found THEN INSERT INTO _pbs_check (item, ok, detail) VALUES ('別租戶被擋', true, SQLSTATE); END;
  BEGIN
    PERFORM public.set_billing_bonus_shares(t, p2, b, NULL, '[]'::jsonb, NULL);
    INSERT INTO _pbs_check (item, ok, detail) VALUES ('期別不屬此專案被擋', false, '竟然成功');
  EXCEPTION WHEN no_data_found THEN INSERT INTO _pbs_check (item, ok, detail) VALUES ('期別不屬此專案被擋', true, SQLSTATE); END;
  BEGIN
    PERFORM public.set_billing_bonus_shares(t, p, b, NULL, jsonb_build_array(jsonb_build_object('employee_id', ex, 'amount', 1)), NULL);
    INSERT INTO _pbs_check (item, ok, detail) VALUES ('別租戶員工被擋', false, '竟然成功');
  EXCEPTION WHEN invalid_parameter_value THEN INSERT INTO _pbs_check (item, ok, detail) VALUES ('別租戶員工被擋', true, SQLSTATE); END;
  BEGIN
    PERFORM public.set_billing_bonus_shares(t, p, b, NULL, jsonb_build_array(jsonb_build_object('employee_id', e1, 'amount', 1), jsonb_build_object('employee_id', e1, 'amount', 2)), NULL);
    INSERT INTO _pbs_check (item, ok, detail) VALUES ('重複員工被擋', false, '竟然成功');
  EXCEPTION WHEN invalid_parameter_value THEN INSERT INTO _pbs_check (item, ok, detail) VALUES ('重複員工被擋', true, SQLSTATE); END;
  BEGIN
    PERFORM public.set_billing_bonus_shares(t, p, b, NULL, jsonb_build_array(jsonb_build_object('employee_id', e1, 'amount', -1)), NULL);
    INSERT INTO _pbs_check (item, ok, detail) VALUES ('負數金額被擋', false, '竟然成功');
  EXCEPTION WHEN invalid_parameter_value THEN INSERT INTO _pbs_check (item, ok, detail) VALUES ('負數金額被擋', true, SQLSTATE); END;
  BEGIN
    PERFORM public.set_billing_bonus_shares(t, p, b, NULL, jsonb_build_array(jsonb_build_object('employee_id', e1, 'amount', 'abc')), NULL);
    INSERT INTO _pbs_check (item, ok, detail) VALUES ('非數字金額被擋', false, '竟然成功');
  EXCEPTION WHEN invalid_parameter_value THEN INSERT INTO _pbs_check (item, ok, detail) VALUES ('非數字金額被擋', true, SQLSTATE); END;
  SELECT count(*) INTO n FROM public.project_billing_shares WHERE billing_id = b;
  INSERT INTO _pbs_check (item, ok, detail) VALUES ('被擋的呼叫不動既有資料', n = 1, n::text);

  -- 表約束
  BEGIN
    INSERT INTO public.project_billing_shares (tenant_id, project_id, billing_id, employee_id, amount) VALUES (t, p, b, e2, 5);
    INSERT INTO _pbs_check (item, ok, detail) VALUES ('同期同人被擋（23505）', false, '竟然寫入成功');
  EXCEPTION WHEN unique_violation THEN INSERT INTO _pbs_check (item, ok, detail) VALUES ('同期同人被擋（23505）', true, SQLSTATE); END;
  BEGIN
    INSERT INTO public.project_billing_shares (tenant_id, project_id, billing_id, employee_id, amount) VALUES (t, p, b, e1, -5);
    INSERT INTO _pbs_check (item, ok, detail) VALUES ('負數被擋（23514）', false, '竟然寫入成功');
  EXCEPTION WHEN check_violation THEN INSERT INTO _pbs_check (item, ok, detail) VALUES ('負數被擋（23514）', true, SQLSTATE); END;
END $$;
SELECT item, ok, detail FROM _pbs_check ORDER BY seq;
ROLLBACK;
