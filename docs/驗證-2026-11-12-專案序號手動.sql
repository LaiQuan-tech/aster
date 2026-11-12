-- 2026-11-12 專案序號可手動調整（migration 0094 ＝ sql/0084）套用後驗證。ok 欄全為 true 才算通過。
-- 第 1 段：唯讀結構檢查（正式庫在前面加 `set transaction read only;` 執行）。
-- 第 2 段：交易內實測（最後 ROLLBACK；在 pglite（npm run db:replay）上跑，正式庫略過）。

-- 1. 結構：索引存在、unique、定義為 (tenant_id, lower(code))；既有資料無大小寫不敏感重複
SELECT item, ok, detail FROM (
  SELECT 1 AS seq, 'projects_tenant_code_ci_uq：unique (tenant_id, lower(code))' AS item,
         count(*) = 1 AND bool_and(indexdef ILIKE '%UNIQUE%' AND indexdef ILIKE '%(tenant_id, lower(code))%') AS ok,
         string_agg(indexdef, ' | ') AS detail
    FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'projects' AND indexname = 'projects_tenant_code_ci_uq'
  UNION ALL
  SELECT 2, '原 projects_tenant_code_uq 仍在', count(*) = 1, string_agg(indexdef, ' | ')
    FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'projects' AND indexname = 'projects_tenant_code_uq'
  UNION ALL
  SELECT 3, '既有序號大小寫不敏感無重複', count(*) = 0, string_agg(lc, ', ')
    FROM (SELECT lower(code) AS lc FROM public.projects WHERE code IS NOT NULL GROUP BY tenant_id, lower(code) HAVING count(*) > 1) d
) t ORDER BY seq;

-- 2. 實測（pglite）：同租戶只差大小寫 → 23505；別租戶同號可以。回一張 ok 表，最後 ROLLBACK 不留資料。
BEGIN;
INSERT INTO public.tenants (id, name, status) VALUES
  ('f0000000-0000-4000-8000-0000000000c1', '測試租戶序號甲', 'active'),
  ('f0000000-0000-4000-8000-0000000000c2', '測試租戶序號乙', 'active');
INSERT INTO public.projects (tenant_id, name, code) VALUES
  ('f0000000-0000-4000-8000-0000000000c1', '驗證序號甲', 'ZZ-CI-001');
CREATE TEMP TABLE _ci_result (seq int, item text, ok boolean) ON COMMIT DROP;
DO $$
BEGIN
  BEGIN
    INSERT INTO public.projects (tenant_id, name, code) VALUES ('f0000000-0000-4000-8000-0000000000c1', '驗證序號乙', 'zz-ci-001');
    INSERT INTO _ci_result VALUES (1, '同租戶只差大小寫被擋（23505）', false);
  EXCEPTION WHEN unique_violation THEN
    INSERT INTO _ci_result VALUES (1, '同租戶只差大小寫被擋（23505）', true);
  END;
  BEGIN
    INSERT INTO public.projects (tenant_id, name, code) VALUES ('f0000000-0000-4000-8000-0000000000c2', '驗證序號丙', 'zz-ci-001');
    INSERT INTO _ci_result VALUES (2, '別租戶同號可以', true);
  EXCEPTION WHEN unique_violation THEN
    INSERT INTO _ci_result VALUES (2, '別租戶同號可以', false);
  END;
  BEGIN
    UPDATE public.projects SET code = 'ZZ-ci-001' WHERE tenant_id = 'f0000000-0000-4000-8000-0000000000c1' AND name = '驗證序號甲';
    INSERT INTO _ci_result VALUES (3, '同一列只改自己的大小寫可以', true);
  EXCEPTION WHEN unique_violation THEN
    INSERT INTO _ci_result VALUES (3, '同一列只改自己的大小寫可以', false);
  END;
END $$;
SELECT item, ok FROM _ci_result ORDER BY seq;
ROLLBACK;
