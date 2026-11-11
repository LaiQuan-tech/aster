-- 2026-11-10 專案申請單版本（migration 0090 ＝ sql/0080）套用後驗證。唯讀＋交易內實測（最後 ROLLBACK，不留任何資料）。
-- 每一段回一張表；ok 欄全為 true 才算通過。

-- 1. project_application_versions 存在、RLS 開、掛 audit_all、沒有任何 policy（只由 API service role 存取）
SELECT count(*) = 1 AS ok, 'project_application_versions 存在' AS item
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relname = 'project_application_versions';
SELECT (c.relrowsecurity
        AND EXISTS (SELECT 1 FROM pg_trigger t WHERE t.tgrelid = c.oid AND t.tgname = 'audit_all' AND NOT t.tgisinternal)
        AND NOT EXISTS (SELECT 1 FROM pg_policies p WHERE p.schemaname = 'public' AND p.tablename = c.relname)) AS ok,
       'RLS 開＋audit_all＋無 policy' AS item
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname = 'public' AND c.relname = 'project_application_versions';

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

-- 4. 交易內實測（ROLLBACK）
BEGIN;
CREATE TEMP TABLE _pav_check (seq serial, item text, ok boolean, detail text) ON COMMIT DROP;
DO $$
DECLARE t uuid; p uuid; v uuid; n int;
BEGIN
  INSERT INTO public.tenants (name) VALUES ('驗證用租戶（會 ROLLBACK）') RETURNING id INTO t;
  INSERT INTO public.projects (tenant_id, name) VALUES (t, '驗證用專案') RETURNING id INTO p;

  INSERT INTO public.project_application_versions (tenant_id, project_id, version_no, snapshot, trigger, amount_after)
    VALUES (t, p, 1, '{"code":"T-1"}', 'initial', 1428571) RETURNING id INTO v;
  INSERT INTO _pav_check (item, ok, detail) VALUES ('第 1 版寫入', v IS NOT NULL, v::text);

  SELECT count(*) INTO n FROM public.audit_logs WHERE table_name = 'project_application_versions' AND record_id = v;
  INSERT INTO _pav_check (item, ok, detail) VALUES ('寫入有 audit_logs', n >= 1, n::text);

  INSERT INTO public.project_application_versions (tenant_id, project_id, version_no, snapshot, trigger, amount_before, amount_after)
    VALUES (t, p, 2, '{"code":"T-1"}', 'contract_amount_changed', 1428571, 1600000);
  INSERT INTO _pav_check (item, ok, detail) VALUES ('第 2 版寫入', true, null);

  BEGIN
    INSERT INTO public.project_application_versions (tenant_id, project_id, version_no, snapshot, trigger) VALUES (t, p, 2, '{}', 'manual');
    INSERT INTO _pav_check (item, ok, detail) VALUES ('同專案同版號被擋（23505）', false, '竟然寫入成功');
  EXCEPTION WHEN unique_violation THEN
    INSERT INTO _pav_check (item, ok, detail) VALUES ('同專案同版號被擋（23505）', true, SQLSTATE);
  END;

  BEGIN
    INSERT INTO public.project_application_versions (tenant_id, project_id, version_no, snapshot, trigger) VALUES (t, p, 3, '{}', 'bogus');
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
    INSERT INTO public.project_application_versions (tenant_id, project_id, version_no, trigger) VALUES (t, p, 4, 'manual');
    INSERT INTO _pav_check (item, ok, detail) VALUES ('snapshot 必填（23502）', false, '竟然寫入成功');
  EXCEPTION WHEN not_null_violation THEN
    INSERT INTO _pav_check (item, ok, detail) VALUES ('snapshot 必填（23502）', true, SQLSTATE);
  END;
END $$;
SELECT item, ok, detail FROM _pav_check ORDER BY seq;
ROLLBACK;
