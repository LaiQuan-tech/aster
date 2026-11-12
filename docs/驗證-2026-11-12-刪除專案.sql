-- 2026-11-12 刪除專案（migration 0095 ＝ sql/0085）套用後驗證。ok 欄全為 true 才算通過。
-- 第 1 段：唯讀結構檢查（正式庫在前面加 `set transaction read only;` 執行）。
-- 第 2 段：交易內實測（最後 ROLLBACK；在 pglite（npm run db:replay）上跑，正式庫略過）。

-- 1. 結構：兩欄存在、FK 存在、兩個序號唯一索引都是 partial（deleted_at is null）、audit_all 觸發器仍掛在 projects
SELECT item, ok, detail FROM (
  SELECT 1 AS seq, 'projects.deleted_at timestamptz' AS item,
         count(*) = 1 AND bool_and(data_type = 'timestamp with time zone') AS ok, string_agg(data_type, ', ') AS detail
    FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'projects' AND column_name = 'deleted_at'
  UNION ALL
  SELECT 2, 'projects.deleted_by_emp_id uuid', count(*) = 1 AND bool_and(data_type = 'uuid'), string_agg(data_type, ', ')
    FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'projects' AND column_name = 'deleted_by_emp_id'
  UNION ALL
  SELECT 3, 'FK deleted_by_emp_id → employees ON DELETE SET NULL', count(*) = 1 AND bool_and(confdeltype = 'n'), string_agg(conname, ', ')
    FROM pg_constraint WHERE conname = 'projects_deleted_by_emp_id_employees_id_fk' AND confrelid = 'public.employees'::regclass
  UNION ALL
  SELECT 4, 'projects_tenant_code_uq：unique (tenant_id, code) WHERE deleted_at IS NULL',
         count(*) = 1 AND bool_and(indexdef ILIKE '%UNIQUE%' AND indexdef ILIKE '%(tenant_id, code)%' AND indexdef ILIKE '%WHERE (deleted_at IS NULL)%'),
         string_agg(indexdef, ' | ')
    FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'projects' AND indexname = 'projects_tenant_code_uq'
  UNION ALL
  SELECT 5, 'projects_tenant_code_ci_uq：unique (tenant_id, lower(code)) WHERE deleted_at IS NULL',
         count(*) = 1 AND bool_and(indexdef ILIKE '%UNIQUE%' AND indexdef ILIKE '%(tenant_id, lower(code))%' AND indexdef ILIKE '%WHERE (deleted_at IS NULL)%'),
         string_agg(indexdef, ' | ')
    FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'projects' AND indexname = 'projects_tenant_code_ci_uq'
  UNION ALL
  SELECT 6, 'audit_all 觸發器仍在 projects（軟刪除 UPDATE 自動稽核）', count(*) = 1, string_agg(tgname, ', ')
    FROM pg_trigger WHERE tgrelid = 'public.projects'::regclass AND tgname = 'audit_all' AND NOT tgisinternal
) t ORDER BY seq;

-- 2. 實測（pglite）：已刪除的序號可重用（大小寫敏感／不敏感兩個索引都放行）；未刪除的仍擋。回一張 ok 表，最後 ROLLBACK 不留資料。
BEGIN;
INSERT INTO public.tenants (id, name, status) VALUES
  ('f0000000-0000-4000-8000-0000000000d1', '測試租戶刪除甲', 'active');
INSERT INTO public.projects (tenant_id, name, code) VALUES
  ('f0000000-0000-4000-8000-0000000000d1', '驗證刪除甲', 'ZZ-DEL-001');
CREATE TEMP TABLE _del_result (seq int, item text, ok boolean) ON COMMIT DROP;
DO $$
BEGIN
  BEGIN
    INSERT INTO public.projects (tenant_id, name, code) VALUES ('f0000000-0000-4000-8000-0000000000d1', '驗證刪除乙', 'zz-del-001');
    INSERT INTO _del_result VALUES (1, '未刪除時同號（大小寫不同）仍被擋', false);
  EXCEPTION WHEN unique_violation THEN
    INSERT INTO _del_result VALUES (1, '未刪除時同號（大小寫不同）仍被擋', true);
  END;
  UPDATE public.projects SET deleted_at = now() WHERE tenant_id = 'f0000000-0000-4000-8000-0000000000d1' AND name = '驗證刪除甲';
  BEGIN
    INSERT INTO public.projects (tenant_id, name, code) VALUES ('f0000000-0000-4000-8000-0000000000d1', '驗證刪除丙', 'ZZ-DEL-001');
    INSERT INTO _del_result VALUES (2, '軟刪除後同號（完全相同）可重用', true);
  EXCEPTION WHEN unique_violation THEN
    INSERT INTO _del_result VALUES (2, '軟刪除後同號（完全相同）可重用', false);
  END;
  BEGIN
    INSERT INTO public.projects (tenant_id, name, code) VALUES ('f0000000-0000-4000-8000-0000000000d1', '驗證刪除丁', 'zz-del-001');
    INSERT INTO _del_result VALUES (3, '重用後再建只差大小寫仍被擋', false);
  EXCEPTION WHEN unique_violation THEN
    INSERT INTO _del_result VALUES (3, '重用後再建只差大小寫仍被擋', true);
  END;
END $$;
INSERT INTO _del_result
SELECT 4, 'audit_logs 記到軟刪除 UPDATE（old deleted_at null → new 非 null）', count(*) >= 1
  FROM public.audit_logs
 WHERE table_name = 'projects' AND action = 'UPDATE'
   AND (old_row ->> 'deleted_at') IS NULL AND (new_row ->> 'deleted_at') IS NOT NULL
   AND new_row ->> 'name' = '驗證刪除甲';
SELECT item, ok FROM _del_result ORDER BY seq;
ROLLBACK;
