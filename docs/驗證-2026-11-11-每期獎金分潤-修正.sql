-- 2026-11-11 每期款獎金分潤修正（migration 0092 ＝ sql/0082）套用後驗證。ok 欄全為 true 才算通過。
-- 第 1 段：唯讀結構檢查（一個查詢回一張表；正式庫在前面加 `set transaction read only;` 執行）。
-- 第 2 段：交易內實測（最後 ROLLBACK，不留任何資料；在 pglite（npm run db:replay）上跑，正式庫略過）。

-- 1. 結構：兩個函式都在、security definer＋固定 search_path、batch 有 advisory lock＋擋代墊款；權限只給 service_role
SELECT item, ok, detail FROM (
  SELECT 1 AS seq, 'set_billing_bonus_shares_batch：security definer＋search_path＋advisory lock＋擋代墊款' AS item,
         count(*) = 1 AND bool_and(p.prosecdef AND array_to_string(p.proconfig, ',') LIKE '%search_path=public%'
                  AND pg_get_functiondef(p.oid) LIKE '%pg_advisory_xact_lock%'
                  AND pg_get_functiondef(p.oid) LIKE '%guild_advance%') AS ok,
         string_agg(pg_get_function_identity_arguments(p.oid), ' | ') AS detail
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'set_billing_bonus_shares_batch'
  UNION ALL
  SELECT 2, 'set_billing_bonus_shares（舊入口）簽章不變、仍 security definer、改呼叫 batch',
         count(*) = 1 AND bool_and(p.prosecdef AND array_to_string(p.proconfig, ',') LIKE '%search_path=public%'
                  AND pg_get_functiondef(p.oid) LIKE '%set_billing_bonus_shares_batch%'),
         string_agg(pg_get_function_identity_arguments(p.oid), ' | ')
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'set_billing_bonus_shares'
  UNION ALL
  SELECT 3, 'batch 執行權限：只有 service_role',
         (NOT has_function_privilege('anon', 'public.set_billing_bonus_shares_batch(uuid, uuid, jsonb, uuid)', 'EXECUTE')
          AND NOT has_function_privilege('authenticated', 'public.set_billing_bonus_shares_batch(uuid, uuid, jsonb, uuid)', 'EXECUTE')
          AND has_function_privilege('service_role', 'public.set_billing_bonus_shares_batch(uuid, uuid, jsonb, uuid)', 'EXECUTE')),
         NULL
  UNION ALL
  SELECT 4, '舊入口執行權限：只有 service_role',
         (NOT has_function_privilege('anon', 'public.set_billing_bonus_shares(uuid, uuid, uuid, date, jsonb, uuid)', 'EXECUTE')
          AND NOT has_function_privilege('authenticated', 'public.set_billing_bonus_shares(uuid, uuid, uuid, date, jsonb, uuid)', 'EXECUTE')
          AND has_function_privilege('service_role', 'public.set_billing_bonus_shares(uuid, uuid, uuid, date, jsonb, uuid)', 'EXECUTE')),
         NULL
  UNION ALL
  SELECT 5, 'PUBLIC 沒有 EXECUTE（兩個函式）',
         NOT EXISTS (
           SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
            WHERE n.nspname = 'public' AND p.proname IN ('set_billing_bonus_shares', 'set_billing_bonus_shares_batch')
              AND a.grantee = 0 AND a.privilege_type = 'EXECUTE'),
         NULL
  UNION ALL
  SELECT 6, '兩張分潤表仍在、RLS 開、無 policy、無 audit_all（0091 不受影響）',
         count(*) = 2 AND bool_and(c.relrowsecurity
                  AND NOT EXISTS (SELECT 1 FROM pg_trigger t WHERE t.tgrelid = c.oid AND t.tgname = 'audit_all' AND NOT t.tgisinternal)
                  AND NOT EXISTS (SELECT 1 FROM pg_policies p WHERE p.schemaname = 'public' AND p.tablename = c.relname)),
         string_agg(c.relname, ', ' ORDER BY c.relname)
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relname IN ('project_billing_shares', 'project_billing_bonus_dates')
) checks ORDER BY seq;

-- 2. 交易內實測（ROLLBACK）：多期全成全敗、代墊款擋、別租戶員工擋、稽核摘要不含金額、舊入口仍可用
BEGIN;
CREATE TEMP TABLE _pbs2_check (seq serial, item text, ok boolean, detail text) ON COMMIT DROP;
DO $$
DECLARE t uuid; t2 uuid; p uuid; p2 uuid; b1 uuid; b2 uuid; bg uuid; bx uuid; e1 uuid; e2 uuid; ex uuid; n int; got text;
BEGIN
  INSERT INTO public.tenants (name) VALUES ('驗證用租戶（會 ROLLBACK）') RETURNING id INTO t;
  INSERT INTO public.tenants (name) VALUES ('驗證用別租戶（會 ROLLBACK）') RETURNING id INTO t2;
  INSERT INTO public.projects (tenant_id, name) VALUES (t, '驗證用專案') RETURNING id INTO p;
  INSERT INTO public.projects (tenant_id, name) VALUES (t, '驗證用另一案') RETURNING id INTO p2;
  INSERT INTO public.project_billings (tenant_id, project_id, installment_no) VALUES (t, p, 1) RETURNING id INTO b1;
  INSERT INTO public.project_billings (tenant_id, project_id, installment_no) VALUES (t, p, 2) RETURNING id INTO b2;
  INSERT INTO public.project_billings (tenant_id, project_id, installment_no, kind) VALUES (t, p, 3, 'guild_advance') RETURNING id INTO bg;
  INSERT INTO public.project_billings (tenant_id, project_id, installment_no) VALUES (t, p2, 1) RETURNING id INTO bx;
  INSERT INTO public.employees (tenant_id, name, role) VALUES (t, '驗證甲', 'employee') RETURNING id INTO e1;
  INSERT INTO public.employees (tenant_id, name, role) VALUES (t, '驗證乙', 'employee') RETURNING id INTO e2;
  INSERT INTO public.employees (tenant_id, name, role) VALUES (t2, '別租戶丙', 'employee') RETURNING id INTO ex;

  -- 兩期一次寫
  n := public.set_billing_bonus_shares_batch(t, p, jsonb_build_array(
         jsonb_build_object('billing_id', b1, 'bonus_paid_on', '2026-12-20',
           'shares', jsonb_build_array(jsonb_build_object('employee_id', e1, 'amount', 30000), jsonb_build_object('employee_id', e2, 'amount', 15000, 'note', ' 備註 '))),
         jsonb_build_object('billing_id', b2, 'bonus_paid_on', NULL, 'shares', jsonb_build_array(jsonb_build_object('employee_id', e1, 'amount', 500)))), NULL);
  SELECT count(*) INTO got FROM public.project_billing_shares WHERE tenant_id = t;
  INSERT INTO _pbs2_check (item, ok, detail) VALUES ('兩期一次寫入（3 人）', n = 3 AND got = '3', n::text || '/' || got);
  SELECT string_agg(bonus_paid_on::text, ',') INTO got FROM public.project_billing_bonus_dates WHERE tenant_id = t;
  INSERT INTO _pbs2_check (item, ok, detail) VALUES ('發獎金日只有第 1 期', got = '2026-12-20', got);

  -- 全成全敗：第 1 期合法（改成 1 人）、第 2 期是別案的期別 → 整批不寫
  BEGIN
    PERFORM public.set_billing_bonus_shares_batch(t, p, jsonb_build_array(
      jsonb_build_object('billing_id', b1, 'shares', jsonb_build_array(jsonb_build_object('employee_id', e1, 'amount', 1))),
      jsonb_build_object('billing_id', bx, 'shares', '[]'::jsonb)), NULL);
    INSERT INTO _pbs2_check (item, ok, detail) VALUES ('別案期別被擋', false, '竟然成功');
  EXCEPTION WHEN no_data_found THEN INSERT INTO _pbs2_check (item, ok, detail) VALUES ('別案期別被擋', true, SQLSTATE); END;
  -- 全成全敗：第 2 期有別租戶員工 → 第 1 期也不寫
  BEGIN
    PERFORM public.set_billing_bonus_shares_batch(t, p, jsonb_build_array(
      jsonb_build_object('billing_id', b1, 'shares', '[]'::jsonb),
      jsonb_build_object('billing_id', b2, 'shares', jsonb_build_array(jsonb_build_object('employee_id', ex, 'amount', 1)))), NULL);
    INSERT INTO _pbs2_check (item, ok, detail) VALUES ('別租戶員工被擋', false, '竟然成功');
  EXCEPTION WHEN invalid_parameter_value THEN INSERT INTO _pbs2_check (item, ok, detail) VALUES ('別租戶員工被擋', true, SQLSTATE); END;
  -- 代墊款期別
  BEGIN
    PERFORM public.set_billing_bonus_shares_batch(t, p, jsonb_build_array(
      jsonb_build_object('billing_id', b1, 'shares', '[]'::jsonb),
      jsonb_build_object('billing_id', bg, 'shares', '[]'::jsonb)), NULL);
    INSERT INTO _pbs2_check (item, ok, detail) VALUES ('代墊款期別被擋', false, '竟然成功');
  EXCEPTION WHEN invalid_parameter_value THEN INSERT INTO _pbs2_check (item, ok, detail) VALUES ('代墊款期別被擋', true, SQLSTATE); END;
  -- 同一期重複、同一期重複員工、負數、日期不合法
  BEGIN
    PERFORM public.set_billing_bonus_shares_batch(t, p, jsonb_build_array(
      jsonb_build_object('billing_id', b1, 'shares', '[]'::jsonb), jsonb_build_object('billing_id', b1, 'shares', '[]'::jsonb)), NULL);
    INSERT INTO _pbs2_check (item, ok, detail) VALUES ('重複期別被擋', false, '竟然成功');
  EXCEPTION WHEN invalid_parameter_value THEN INSERT INTO _pbs2_check (item, ok, detail) VALUES ('重複期別被擋', true, SQLSTATE); END;
  BEGIN
    PERFORM public.set_billing_bonus_shares_batch(t, p, jsonb_build_array(
      jsonb_build_object('billing_id', b1, 'shares', jsonb_build_array(jsonb_build_object('employee_id', e1, 'amount', 1), jsonb_build_object('employee_id', e1, 'amount', 2)))), NULL);
    INSERT INTO _pbs2_check (item, ok, detail) VALUES ('同期重複員工被擋', false, '竟然成功');
  EXCEPTION WHEN invalid_parameter_value THEN INSERT INTO _pbs2_check (item, ok, detail) VALUES ('同期重複員工被擋', true, SQLSTATE); END;
  BEGIN
    PERFORM public.set_billing_bonus_shares_batch(t, p, jsonb_build_array(
      jsonb_build_object('billing_id', b1, 'shares', jsonb_build_array(jsonb_build_object('employee_id', e1, 'amount', -1)))), NULL);
    INSERT INTO _pbs2_check (item, ok, detail) VALUES ('負數被擋', false, '竟然成功');
  EXCEPTION WHEN invalid_parameter_value THEN INSERT INTO _pbs2_check (item, ok, detail) VALUES ('負數被擋', true, SQLSTATE); END;
  BEGIN
    PERFORM public.set_billing_bonus_shares_batch(t, p, jsonb_build_array(
      jsonb_build_object('billing_id', b1, 'bonus_paid_on', '2026-02-30', 'shares', '[]'::jsonb)), NULL);
    INSERT INTO _pbs2_check (item, ok, detail) VALUES ('不存在的日期被擋', false, '竟然成功');
  EXCEPTION WHEN OTHERS THEN INSERT INTO _pbs2_check (item, ok, detail) VALUES ('不存在的日期被擋', true, SQLSTATE); END;
  BEGIN
    PERFORM public.set_billing_bonus_shares_batch(t, p, '[]'::jsonb, NULL);
    INSERT INTO _pbs2_check (item, ok, detail) VALUES ('空陣列被擋', false, '竟然成功');
  EXCEPTION WHEN invalid_parameter_value THEN INSERT INTO _pbs2_check (item, ok, detail) VALUES ('空陣列被擋', true, SQLSTATE); END;

  SELECT string_agg(amount::text, ',' ORDER BY amount) INTO got FROM public.project_billing_shares WHERE tenant_id = t;
  INSERT INTO _pbs2_check (item, ok, detail) VALUES ('被擋的呼叫完全不動既有資料', got = '500,15000,30000', got);

  -- 舊入口仍可用（單期）、也擋代墊款
  n := public.set_billing_bonus_shares(t, p, b2, DATE '2027-01-05', jsonb_build_array(jsonb_build_object('employee_id', e2, 'amount', 700)), NULL);
  SELECT count(*) INTO n FROM public.project_billing_shares WHERE billing_id = b2 AND employee_id = e2;
  SELECT bonus_paid_on::text INTO got FROM public.project_billing_bonus_dates WHERE billing_id = b2;
  INSERT INTO _pbs2_check (item, ok, detail) VALUES ('舊入口單期整批換掉＋發獎金日', n = 1 AND got = '2027-01-05', n::text || '/' || got);
  BEGIN
    PERFORM public.set_billing_bonus_shares(t, p, bg, NULL, '[]'::jsonb, NULL);
    INSERT INTO _pbs2_check (item, ok, detail) VALUES ('舊入口也擋代墊款', false, '竟然成功');
  EXCEPTION WHEN invalid_parameter_value THEN INSERT INTO _pbs2_check (item, ok, detail) VALUES ('舊入口也擋代墊款', true, SQLSTATE); END;

  -- 稽核摘要：每期一筆、不含金額
  SELECT count(*) INTO n FROM public.audit_logs WHERE table_name = 'project_billing_shares' AND tenant_id = t;
  INSERT INTO _pbs2_check (item, ok, detail) VALUES ('稽核摘要每期一筆（2＋1）', n = 3, n::text);
  SELECT count(*) INTO n FROM public.audit_logs
   WHERE table_name = 'project_billing_shares' AND tenant_id = t
     AND (new_row::text LIKE '%30000%' OR new_row::text LIKE '%amount%' OR new_row ? 'shares');
  INSERT INTO _pbs2_check (item, ok, detail) VALUES ('稽核不含金額', n = 0, n::text);
END $$;
SELECT item, ok, detail FROM _pbs2_check ORDER BY seq;
ROLLBACK;
