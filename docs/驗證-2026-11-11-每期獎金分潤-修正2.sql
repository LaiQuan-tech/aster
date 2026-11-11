-- 2026-11-11 每期款獎金分潤修正 2（migration 0093 ＝ sql/0083）套用後驗證。ok 欄全為 true 才算通過。
-- 第 1 段：唯讀結構檢查（一個查詢回一張表；正式庫在前面加 `set transaction read only;` 執行）。
-- 第 2 段：交易內實測（最後 ROLLBACK，不留任何資料；在 pglite（npm run db:replay）上跑，正式庫略過）。

-- 1. 結構：batch 有 FOR SHARE 鎖＋代墊款只允許清除；觸發器函式 security definer＋固定 search_path；觸發器掛在 project_billings
SELECT item, ok, detail FROM (
  SELECT 1 AS seq, 'set_billing_bonus_shares_batch：security definer＋search_path＋advisory lock＋期別列 FOR SHARE＋代墊款只允許清除' AS item,
         count(*) = 1 AND bool_and(p.prosecdef AND array_to_string(p.proconfig, ',') LIKE '%search_path=public%'
                  AND pg_get_functiondef(p.oid) LIKE '%pg_advisory_xact_lock%'
                  AND pg_get_functiondef(p.oid) LIKE '%FOR SHARE OF b%'
                  AND pg_get_functiondef(p.oid) LIKE '%guild_advance%'
                  AND pg_get_functiondef(p.oid) LIKE '%jsonb_array_length(i.v -> ''shares'') > 0%') AS ok,
         string_agg(pg_get_function_identity_arguments(p.oid), ' | ') AS detail
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'set_billing_bonus_shares_batch'
  UNION ALL
  SELECT 2, 'batch 執行權限：只有 service_role（PUBLIC／anon／authenticated 沒有）',
         (NOT has_function_privilege('anon', 'public.set_billing_bonus_shares_batch(uuid, uuid, jsonb, uuid)', 'EXECUTE')
          AND NOT has_function_privilege('authenticated', 'public.set_billing_bonus_shares_batch(uuid, uuid, jsonb, uuid)', 'EXECUTE')
          AND has_function_privilege('service_role', 'public.set_billing_bonus_shares_batch(uuid, uuid, jsonb, uuid)', 'EXECUTE')
          AND NOT EXISTS (
            SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
             WHERE n.nspname = 'public' AND p.proname IN ('set_billing_bonus_shares', 'set_billing_bonus_shares_batch', 'project_billings_bonus_shares_guard')
               AND a.grantee = 0 AND a.privilege_type = 'EXECUTE')),
         NULL
  UNION ALL
  SELECT 3, 'project_billings_bonus_shares_guard()：security definer＋search_path＋errcode BS409；anon／authenticated 不能執行',
         count(*) = 1 AND bool_and(p.prosecdef AND array_to_string(p.proconfig, ',') LIKE '%search_path=public%'
                  AND pg_get_functiondef(p.oid) LIKE '%BS409%'
                  AND pg_get_functiondef(p.oid) LIKE '%project_billing_shares%'
                  AND pg_get_functiondef(p.oid) LIKE '%project_billing_bonus_dates%'
                  AND NOT has_function_privilege('anon', p.oid, 'EXECUTE')
                  AND NOT has_function_privilege('authenticated', p.oid, 'EXECUTE')),
         string_agg(p.prorettype::regtype::text, ',')
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'project_billings_bonus_shares_guard'
  UNION ALL
  SELECT 4, '觸發器：project_billings BEFORE UPDATE OF deleted_at, kind、逐列、有 WHEN 條件、啟用中',
         count(*) = 1 AND bool_and(t.tgenabled = 'O'
                  AND pg_get_triggerdef(t.oid) LIKE '%BEFORE UPDATE OF deleted_at, kind ON public.project_billings FOR EACH ROW WHEN%'
                  AND pg_get_triggerdef(t.oid) LIKE '%guild_advance%'
                  AND t.tgfoid = 'public.project_billings_bonus_shares_guard()'::regprocedure),
         string_agg(t.tgname, ', ')
    FROM pg_trigger t
   WHERE t.tgrelid = 'public.project_billings'::regclass AND t.tgname = 'project_billings_bonus_shares_guard' AND NOT t.tgisinternal
  UNION ALL
  SELECT 5, 'project_billings 其他觸發器不受影響（列出全部）',
         true,
         string_agg(t.tgname || ':' || CASE t.tgenabled WHEN 'O' THEN 'on' ELSE t.tgenabled::text END, ', ' ORDER BY t.tgname)
    FROM pg_trigger t
   WHERE t.tgrelid = 'public.project_billings'::regclass AND NOT t.tgisinternal
  UNION ALL
  SELECT 6, '既有資料：已刪期別上的分潤／發獎金日列數（0 才乾淨）',
         count(*) = 0, count(*)::text
    FROM (
      SELECT s.billing_id FROM public.project_billing_shares s JOIN public.project_billings b ON b.id = s.billing_id WHERE b.deleted_at IS NOT NULL
      UNION ALL
      SELECT d.billing_id FROM public.project_billing_bonus_dates d JOIN public.project_billings b ON b.id = d.billing_id WHERE b.deleted_at IS NOT NULL
    ) x
  UNION ALL
  SELECT 7, '既有資料：代墊款期別上的分潤／發獎金日列數（0 才乾淨；非 0 可用清除動作自救）',
         count(*) = 0, count(*)::text
    FROM (
      SELECT s.billing_id FROM public.project_billing_shares s JOIN public.project_billings b ON b.id = s.billing_id WHERE b.kind = 'guild_advance'
      UNION ALL
      SELECT d.billing_id FROM public.project_billing_bonus_dates d JOIN public.project_billings b ON b.id = d.billing_id WHERE b.kind = 'guild_advance'
    ) x
) checks ORDER BY seq;

-- 2. 交易內實測（ROLLBACK）：觸發器擋刪除／改代墊款、其他欄位照改、audit_all 照寫、代墊款清除可自救
BEGIN;
CREATE TEMP TABLE _pbs3_check (seq serial, item text, ok boolean, detail text) ON COMMIT DROP;
DO $$
DECLARE t uuid; p uuid; b1 uuid; b2 uuid; b3 uuid; bg uuid; e1 uuid; n int; n0 int; got text; has_audit boolean;
BEGIN
  INSERT INTO public.tenants (name) VALUES ('驗證用租戶（會 ROLLBACK）') RETURNING id INTO t;
  INSERT INTO public.projects (tenant_id, name) VALUES (t, '驗證用專案') RETURNING id INTO p;
  INSERT INTO public.project_billings (tenant_id, project_id, installment_no) VALUES (t, p, 1) RETURNING id INTO b1;
  INSERT INTO public.project_billings (tenant_id, project_id, installment_no) VALUES (t, p, 2) RETURNING id INTO b2;
  INSERT INTO public.project_billings (tenant_id, project_id, installment_no) VALUES (t, p, 3) RETURNING id INTO b3;
  INSERT INTO public.project_billings (tenant_id, project_id, installment_no, kind) VALUES (t, p, 4, 'guild_advance') RETURNING id INTO bg;
  INSERT INTO public.employees (tenant_id, name, role) VALUES (t, '驗證甲', 'employee') RETURNING id INTO e1;

  -- b1 有分潤、b2 只有發獎金日、b3 什麼都沒有
  PERFORM public.set_billing_bonus_shares_batch(t, p, jsonb_build_array(
    jsonb_build_object('billing_id', b1, 'shares', jsonb_build_array(jsonb_build_object('employee_id', e1, 'amount', 100.5))),
    jsonb_build_object('billing_id', b2, 'bonus_paid_on', '2026-12-20', 'shares', '[]'::jsonb)), NULL);

  BEGIN
    UPDATE public.project_billings SET deleted_at = now(), delete_reason = '驗證' WHERE id = b1;
    INSERT INTO _pbs3_check (item, ok, detail) VALUES ('有分潤的期別軟刪除被擋', false, '竟然成功');
  EXCEPTION WHEN SQLSTATE 'BS409' THEN INSERT INTO _pbs3_check (item, ok, detail) VALUES ('有分潤的期別軟刪除被擋', true, SQLSTATE); END;
  BEGIN
    UPDATE public.project_billings SET deleted_at = now() WHERE id = b2;
    INSERT INTO _pbs3_check (item, ok, detail) VALUES ('只有發獎金日的期別軟刪除被擋', false, '竟然成功');
  EXCEPTION WHEN SQLSTATE 'BS409' THEN INSERT INTO _pbs3_check (item, ok, detail) VALUES ('只有發獎金日的期別軟刪除被擋', true, SQLSTATE); END;
  BEGIN
    UPDATE public.project_billings SET kind = 'guild_advance' WHERE id = b1;
    INSERT INTO _pbs3_check (item, ok, detail) VALUES ('有分潤的期別改成代墊款被擋', false, '竟然成功');
  EXCEPTION WHEN SQLSTATE 'BS409' THEN INSERT INTO _pbs3_check (item, ok, detail) VALUES ('有分潤的期別改成代墊款被擋', true, SQLSTATE); END;
  SELECT count(*) INTO n FROM public.project_billings WHERE id IN (b1, b2) AND deleted_at IS NULL AND kind = 'installment';
  INSERT INTO _pbs3_check (item, ok, detail) VALUES ('被擋的更新完全沒生效', n = 2, n::text);

  -- 其他欄位照改（含同時帶 kind 不變、deleted_at 仍 null 的整列更新，如 API 的期程 PUT）；audit_all 照寫
  SELECT EXISTS (SELECT 1 FROM pg_trigger tg WHERE tg.tgrelid = 'public.project_billings'::regclass AND tg.tgname = 'audit_all' AND NOT tg.tgisinternal) INTO has_audit;
  SELECT count(*) INTO n0 FROM public.audit_logs WHERE table_name = 'project_billings' AND record_id = b1;
  UPDATE public.project_billings SET milestone = '驗證說明', percentage = 30, kind = 'installment', note = '備註' WHERE id = b1;
  SELECT count(*) INTO n FROM public.audit_logs WHERE table_name = 'project_billings' AND record_id = b1;
  SELECT milestone INTO got FROM public.project_billings WHERE id = b1;
  INSERT INTO _pbs3_check (item, ok, detail)
  VALUES ('有分潤的期別改其他欄位照常（audit_all 照寫）', got = '驗證說明' AND (NOT has_audit OR n = n0 + 1),
          got || ' / audit ' || n0 || '→' || n || CASE WHEN has_audit THEN '' ELSE '（無 audit_all）' END);

  -- 沒有分潤的期別：刪除、改代墊款都照常
  UPDATE public.project_billings SET kind = 'guild_advance' WHERE id = b3;
  UPDATE public.project_billings SET deleted_at = now() WHERE id = b3;
  SELECT count(*) INTO n FROM public.project_billings WHERE id = b3 AND deleted_at IS NOT NULL AND kind = 'guild_advance';
  INSERT INTO _pbs3_check (item, ok, detail) VALUES ('沒有分潤的期別改代墊款＋軟刪除照常', n = 1, n::text);

  -- 先清分潤再刪：可以
  PERFORM public.set_billing_bonus_shares_batch(t, p, jsonb_build_array(
    jsonb_build_object('billing_id', b1, 'bonus_paid_on', NULL, 'shares', '[]'::jsonb),
    jsonb_build_object('billing_id', b2, 'bonus_paid_on', NULL, 'shares', '[]'::jsonb)), NULL);
  UPDATE public.project_billings SET deleted_at = now() WHERE id IN (b1, b2);
  SELECT count(*) INTO n FROM public.project_billings WHERE id IN (b1, b2) AND deleted_at IS NOT NULL;
  INSERT INTO _pbs3_check (item, ok, detail) VALUES ('先清除分潤／發獎金日再軟刪除成功', n = 2, n::text);

  -- 已刪期別不能再寫分潤（step 3 FOR SHARE 後的檢查）
  BEGIN
    PERFORM public.set_billing_bonus_shares_batch(t, p, jsonb_build_array(
      jsonb_build_object('billing_id', b1, 'shares', jsonb_build_array(jsonb_build_object('employee_id', e1, 'amount', 1)))), NULL);
    INSERT INTO _pbs3_check (item, ok, detail) VALUES ('已刪期別寫分潤被擋', false, '竟然成功');
  EXCEPTION WHEN no_data_found THEN INSERT INTO _pbs3_check (item, ok, detail) VALUES ('已刪期別寫分潤被擋', true, SQLSTATE); END;

  -- 代墊款舊資料自救：直接塞一筆舊資料（模擬 0092 前寫入的），清除動作可以、寫入非空仍擋
  INSERT INTO public.project_billing_shares (tenant_id, project_id, billing_id, employee_id, amount) VALUES (t, p, bg, e1, 5);
  INSERT INTO public.project_billing_bonus_dates (billing_id, tenant_id, project_id, bonus_paid_on) VALUES (bg, t, p, DATE '2026-12-01');
  BEGIN
    PERFORM public.set_billing_bonus_shares_batch(t, p, jsonb_build_array(
      jsonb_build_object('billing_id', bg, 'bonus_paid_on', '2026-12-02', 'shares', '[]'::jsonb)), NULL);
    INSERT INTO _pbs3_check (item, ok, detail) VALUES ('代墊款只設發獎金日被擋', false, '竟然成功');
  EXCEPTION WHEN invalid_parameter_value THEN INSERT INTO _pbs3_check (item, ok, detail) VALUES ('代墊款只設發獎金日被擋', true, SQLSTATE); END;
  BEGIN
    PERFORM public.set_billing_bonus_shares_batch(t, p, jsonb_build_array(
      jsonb_build_object('billing_id', bg, 'shares', jsonb_build_array(jsonb_build_object('employee_id', e1, 'amount', 1)))), NULL);
    INSERT INTO _pbs3_check (item, ok, detail) VALUES ('代墊款寫入分潤被擋', false, '竟然成功');
  EXCEPTION WHEN invalid_parameter_value THEN INSERT INTO _pbs3_check (item, ok, detail) VALUES ('代墊款寫入分潤被擋', true, SQLSTATE); END;
  n := public.set_billing_bonus_shares_batch(t, p, jsonb_build_array(
    jsonb_build_object('billing_id', bg, 'bonus_paid_on', NULL, 'shares', '[]'::jsonb)), NULL);
  SELECT (SELECT count(*) FROM public.project_billing_shares WHERE billing_id = bg) + (SELECT count(*) FROM public.project_billing_bonus_dates WHERE billing_id = bg) INTO n0;
  INSERT INTO _pbs3_check (item, ok, detail) VALUES ('代墊款清除（shares 空＋日期 null）可自救', n = 0 AND n0 = 0, n::text || '/' || n0::text);
  -- 舊入口也一樣
  n := public.set_billing_bonus_shares(t, p, bg, NULL, '[]'::jsonb, NULL);
  INSERT INTO _pbs3_check (item, ok, detail) VALUES ('舊入口代墊款清除也可以', n = 0, n::text);
END $$;
SELECT item, ok, detail FROM _pbs3_check ORDER BY seq;
ROLLBACK;
