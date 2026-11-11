-- 2026-11-10 專案申請單版本（migration 0090 ＝ sql/0080）套用後驗證。唯讀＋交易內實測（最後 ROLLBACK，不留任何資料）。
-- 每一段回一張表；ok 欄全為 true 才算通過。

-- 1. project_application_versions 存在、RLS 開、沒有 policy、**不掛 audit_all**（快照含利潤，不能整份進稽核）
SELECT count(*) = 1 AS ok, 'project_application_versions 存在' AS item
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relname = 'project_application_versions';
SELECT (c.relrowsecurity
        AND NOT EXISTS (SELECT 1 FROM pg_trigger t WHERE t.tgrelid = c.oid AND t.tgname = 'audit_all' AND NOT t.tgisinternal)
        AND NOT EXISTS (SELECT 1 FROM pg_policies p WHERE p.schemaname = 'public' AND p.tablename = c.relname)) AS ok,
       'RLS 開＋無 audit_all＋無 policy' AS item
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname = 'public' AND c.relname = 'project_application_versions';

-- 1b. 建版函式：security definer、固定 search_path、含 advisory lock；anon／authenticated 不能執行、service_role 可以
SELECT (p.prosecdef AND array_to_string(p.proconfig, ',') LIKE '%search_path=public%'
        AND pg_get_functiondef(p.oid) LIKE '%pg_advisory_xact_lock%') AS ok,
       'record_application_version security definer＋search_path＋advisory lock' AS item
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname = 'public' AND p.proname = 'record_application_version';
SELECT (NOT has_function_privilege('anon', 'public.record_application_version(uuid, uuid, text, jsonb, jsonb, numeric, numeric, text, uuid)', 'EXECUTE')
        AND NOT has_function_privilege('authenticated', 'public.record_application_version(uuid, uuid, text, jsonb, jsonb, numeric, numeric, text, uuid)', 'EXECUTE')
        AND has_function_privilege('service_role', 'public.record_application_version(uuid, uuid, text, jsonb, jsonb, numeric, numeric, text, uuid)', 'EXECUTE')) AS ok,
       '函式執行權限：只有 service_role' AS item;

-- 2. 欄位與型別
SELECT count(*) = 12 AS ok, string_agg(column_name || ':' || data_type, ', ' ORDER BY ordinal_position) AS columns
  FROM information_schema.columns
 WHERE table_schema = 'public' AND table_name = 'project_application_versions'
   AND (column_name, data_type) IN (
     ('id','uuid'), ('tenant_id','uuid'), ('project_id','uuid'), ('version_no','integer'), ('snapshot','jsonb'),
     ('trigger','text'), ('amount_before','numeric'), ('amount_after','numeric'), ('note','text'),
     ('created_by_emp_id','uuid'), ('created_at','timestamp with time zone'), ('superseded_at','timestamp with time zone')
   );

-- 3. CHECK 與索引
SELECT count(*) = 3 AS ok, string_agg(conname, ', ' ORDER BY conname) AS checks
  FROM pg_constraint
 WHERE conrelid = 'public.project_application_versions'::regclass AND contype = 'c'
   AND conname IN ('project_application_versions_trigger_chk', 'project_application_versions_no_chk', 'project_application_versions_note_chk');
SELECT count(*) = 2 AS ok, string_agg(indexname, ', ' ORDER BY indexname) AS indexes
  FROM pg_indexes WHERE schemaname = 'public'
   AND indexname IN ('project_application_versions_project_no_uq', 'project_application_versions_tenant_project_idx');

-- 4. 交易內實測（ROLLBACK）：表約束＋建版函式邏輯＋稽核摘要不含快照
BEGIN;
CREATE TEMP TABLE _pav_check (seq serial, item text, ok boolean, detail text) ON COMMIT DROP;
DO $$
DECLARE t uuid; t2 uuid; p uuid; v uuid; n int; got text;
BEGIN
  INSERT INTO public.tenants (name) VALUES ('驗證用租戶（會 ROLLBACK）') RETURNING id INTO t;
  INSERT INTO public.tenants (name) VALUES ('驗證用別租戶（會 ROLLBACK）') RETURNING id INTO t2;
  INSERT INTO public.projects (tenant_id, name) VALUES (t, '驗證用專案') RETURNING id INTO p;

  -- 函式：第一次改金額 → 第 1 版 initial（改前，已被取代）＋第 2 版 changed
  n := public.record_application_version(t, p, 'contract_amount_changed', '{"v":"before1","money":{"profit":1}}', '{"v":"after1"}', 1428571, 1600000, NULL, NULL);
  SELECT string_agg(version_no || ':' || trigger || ':' || coalesce(amount_before::text, '-') || '→' || coalesce(amount_after::text, '-')
                    || ':' || (superseded_at IS NOT NULL)::text || ':' || (snapshot ->> 'v'), ' | ' ORDER BY version_no)
    INTO got FROM public.project_application_versions WHERE project_id = p;
  INSERT INTO _pav_check (item, ok, detail) VALUES ('首次改金額 → v1 initial＋v2 changed',
    n = 2 AND got = '1:initial:-→1428571:true:before1 | 2:contract_amount_changed:1428571→1600000:false:after1', got);

  -- 再改 → v3；v2 快照凍結成改前內容
  n := public.record_application_version(t, p, 'contract_amount_changed', '{"v":"before2"}', '{"v":"after2"}', 1600000, 1700000, NULL, NULL);
  SELECT string_agg(version_no || ':' || (superseded_at IS NOT NULL)::text || ':' || (snapshot ->> 'v'), ' | ' ORDER BY version_no)
    INTO got FROM public.project_application_versions WHERE project_id = p;
  INSERT INTO _pav_check (item, ok, detail) VALUES ('再改 → v3、v2 凍結為改前內容',
    n = 3 AND got = '1:true:before1 | 2:true:before2 | 3:false:after2', got);

  -- 手動另存 → v4（amount_before NULL、備註）
  n := public.record_application_version(t, p, 'manual', '{"v":"now"}', '{"v":"now"}', NULL, 1700000, '送業主前', NULL);
  SELECT trigger || ':' || coalesce(amount_before::text, '-') || ':' || note INTO got FROM public.project_application_versions WHERE project_id = p AND version_no = 4;
  INSERT INTO _pav_check (item, ok, detail) VALUES ('手動另存 → v4 manual', n = 4 AND got = 'manual:-:送業主前', got);

  -- 稽核摘要：每次建版有紀錄，且全部不含 snapshot（利潤不外洩）
  SELECT count(*) INTO n FROM public.audit_logs WHERE table_name = 'project_application_versions' AND tenant_id = t;
  INSERT INTO _pav_check (item, ok, detail) VALUES ('建版有稽核摘要', n >= 6, n::text);
  SELECT count(*) INTO n FROM public.audit_logs
   WHERE table_name = 'project_application_versions'
     AND ((new_row IS NOT NULL AND new_row ? 'snapshot') OR (old_row IS NOT NULL AND old_row ? 'snapshot'));
  INSERT INTO _pav_check (item, ok, detail) VALUES ('稽核不含 snapshot', n = 0, n::text);

  -- 別租戶的專案：拒絕
  BEGIN
    PERFORM public.record_application_version(t2, p, 'manual', '{}', '{}', NULL, NULL, NULL, NULL);
    INSERT INTO _pav_check (item, ok, detail) VALUES ('別租戶專案被擋', false, '竟然成功');
  EXCEPTION WHEN no_data_found THEN
    INSERT INTO _pav_check (item, ok, detail) VALUES ('別租戶專案被擋', true, SQLSTATE);
  END;
  -- 不能用函式直接寫 initial
  BEGIN
    PERFORM public.record_application_version(t, p, 'initial', '{}', '{}', NULL, NULL, NULL, NULL);
    INSERT INTO _pav_check (item, ok, detail) VALUES ('trigger=initial 由函式內部決定（外部傳入被擋）', false, '竟然成功');
  EXCEPTION WHEN invalid_parameter_value THEN
    INSERT INTO _pav_check (item, ok, detail) VALUES ('trigger=initial 由函式內部決定（外部傳入被擋）', true, SQLSTATE);
  END;

  -- 表約束
  BEGIN
    INSERT INTO public.project_application_versions (tenant_id, project_id, version_no, snapshot, trigger) VALUES (t, p, 2, '{}', 'manual');
    INSERT INTO _pav_check (item, ok, detail) VALUES ('同專案同版號被擋（23505）', false, '竟然寫入成功');
  EXCEPTION WHEN unique_violation THEN
    INSERT INTO _pav_check (item, ok, detail) VALUES ('同專案同版號被擋（23505）', true, SQLSTATE);
  END;
  BEGIN
    INSERT INTO public.project_application_versions (tenant_id, project_id, version_no, snapshot, trigger) VALUES (t, p, 9, '{}', 'bogus');
    INSERT INTO _pav_check (item, ok, detail) VALUES ('未知 trigger 被擋（23514）', false, '竟然寫入成功');
  EXCEPTION WHEN check_violation THEN
    INSERT INTO _pav_check (item, ok, detail) VALUES ('未知 trigger 被擋（23514）', true, SQLSTATE);
  END;
  BEGIN
    INSERT INTO public.project_application_versions (tenant_id, project_id, version_no, snapshot, trigger) VALUES (t, p, 0, '{}', 'manual');
    INSERT INTO _pav_check (item, ok, detail) VALUES ('版號 0 被擋（23514）', false, '竟然寫入成功');
  EXCEPTION WHEN check_violation THEN
    INSERT INTO _pav_check (item, ok, detail) VALUES ('版號 0 被擋（23514）', true, SQLSTATE);
  END;
  BEGIN
    INSERT INTO public.project_application_versions (tenant_id, project_id, version_no, trigger) VALUES (t, p, 10, 'manual');
    INSERT INTO _pav_check (item, ok, detail) VALUES ('snapshot 必填（23502）', false, '竟然寫入成功');
  EXCEPTION WHEN not_null_violation THEN
    INSERT INTO _pav_check (item, ok, detail) VALUES ('snapshot 必填（23502）', true, SQLSTATE);
  END;
END $$;
SELECT item, ok, detail FROM _pav_check ORDER BY seq;
ROLLBACK;
