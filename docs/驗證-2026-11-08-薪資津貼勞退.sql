-- 2026-11-08 薪資：員工固定津貼＋勞退月提繳工資（migration 0086 ＝ sql/0076）套用後驗證。唯讀＋交易內實測（最後 ROLLBACK，不留任何資料）。
-- 每一段回一張表；ok 欄全為 true 才算通過。雇主提撥率／勞退分級表／伙食費免稅額存在 rule_configs.config（jsonb），不需驗表。

-- 1. 表存在、RLS 開、掛 audit_all、沒有任何 policy（只由 API service role 存取）
SELECT c.relname AS table_name,
       c.relrowsecurity AS rls_on,
       EXISTS (SELECT 1 FROM pg_trigger t WHERE t.tgrelid = c.oid AND t.tgname = 'audit_all' AND NOT t.tgisinternal) AS has_audit_all,
       NOT EXISTS (SELECT 1 FROM pg_policies p WHERE p.schemaname = 'public' AND p.tablename = c.relname) AS no_policy,
       (c.relrowsecurity
        AND EXISTS (SELECT 1 FROM pg_trigger t WHERE t.tgrelid = c.oid AND t.tgname = 'audit_all' AND NOT t.tgisinternal)
        AND NOT EXISTS (SELECT 1 FROM pg_policies p WHERE p.schemaname = 'public' AND p.tablename = c.relname)) AS ok
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname = 'public' AND c.relname = 'employee_fixed_allowances';

SELECT count(*) = 1 AS ok, 'employee_fixed_allowances 存在' AS item
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relname = 'employee_fixed_allowances';

-- 2. 欄位與型別
SELECT count(*) = 14 AS ok, string_agg(column_name || ':' || data_type, ', ' ORDER BY ordinal_position) AS columns
  FROM information_schema.columns
 WHERE table_schema = 'public' AND table_name = 'employee_fixed_allowances'
   AND (column_name, data_type) IN (
     ('id','uuid'), ('tenant_id','uuid'), ('employee_id','uuid'), ('name','text'), ('amount','integer'),
     ('insurable','boolean'), ('tax_type','text'), ('effective_from','date'), ('effective_to','date'), ('note','text'),
     ('created_by_emp_id','uuid'), ('created_at','timestamp with time zone'), ('updated_at','timestamp with time zone'),
     ('deleted_at','timestamp with time zone')
   );

-- 3. 四個 CHECK、索引存在
SELECT count(*) = 4 AS ok, string_agg(conname, ', ' ORDER BY conname) AS checks
  FROM pg_constraint
 WHERE conrelid = 'public.employee_fixed_allowances'::regclass AND contype = 'c'
   AND conname IN ('employee_fixed_allowances_amount_chk', 'employee_fixed_allowances_tax_type_chk',
                   'employee_fixed_allowances_name_chk', 'employee_fixed_allowances_dates_chk');
SELECT EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'employee_fixed_allowances_tenant_emp_idx') AS ok,
       'index employee_fixed_allowances_tenant_emp_idx' AS item;

-- 3b. salary_structures 新增兩欄（型別、可否為空、預設值）＋CHECK。可重跑：HR 之後填了提繳工資／取消新制也照樣通過，
--     所以這裡**不**檢查既有列的值（「套用當下不改既有資料」由 db:replay 的種子＋本檔 4g 實測驗證）。
SELECT count(*) = 2 AS ok, string_agg(column_name || ':' || data_type || ':' || is_nullable || ':' || coalesce(column_default, ''), ', ') AS columns
  FROM information_schema.columns
 WHERE table_schema = 'public' AND table_name = 'salary_structures'
   AND ((column_name = 'pension_wage' AND data_type = 'integer' AND is_nullable = 'YES')
     OR (column_name = 'pension_new_system' AND data_type = 'boolean' AND is_nullable = 'NO' AND column_default = 'true'));
SELECT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.salary_structures'::regclass AND conname = 'salary_structures_pension_wage_chk') AS ok,
       'salary_structures_pension_wage_chk' AS item;

-- 4. 交易內實測（ROLLBACK）
BEGIN;
CREATE TEMP TABLE _fa_check (seq serial, item text, ok boolean, detail text) ON COMMIT DROP;
DO $$
DECLARE
  t uuid; e uuid; a uuid; got text;
BEGIN
  INSERT INTO public.tenants (name) VALUES ('驗證用租戶（會 ROLLBACK）') RETURNING id INTO t;
  INSERT INTO public.employees (tenant_id, name) VALUES (t, '驗證用員工') RETURNING id INTO e;

  -- 4a. 合法列：預設 insurable=true、tax_type='taxable'
  INSERT INTO public.employee_fixed_allowances (tenant_id, employee_id, name, amount, effective_from)
    VALUES (t, e, '驗證津貼', 3000, '2030-01-01') RETURNING id INTO a;
  SELECT insurable::text || '/' || tax_type INTO got FROM public.employee_fixed_allowances WHERE id = a;
  INSERT INTO _fa_check (item, ok, detail) VALUES ('合法列寫入、預設 insurable=true／taxable', got = 'true/taxable', got);

  -- 4b. 金額負數 → 23514
  BEGIN
    INSERT INTO public.employee_fixed_allowances (tenant_id, employee_id, name, amount, effective_from) VALUES (t, e, 'x', -1, '2030-01-01');
    INSERT INTO _fa_check (item, ok, detail) VALUES ('負金額被擋（23514）', false, '竟然寫入成功');
  EXCEPTION WHEN check_violation THEN
    INSERT INTO _fa_check (item, ok, detail) VALUES ('負金額被擋（23514）', true, SQLSTATE);
  END;

  -- 4c. 課稅方式不認得 → 23514
  BEGIN
    INSERT INTO public.employee_fixed_allowances (tenant_id, employee_id, name, amount, tax_type, effective_from) VALUES (t, e, 'x', 1, 'weird', '2030-01-01');
    INSERT INTO _fa_check (item, ok, detail) VALUES ('不認得的課稅方式被擋（23514）', false, '竟然寫入成功');
  EXCEPTION WHEN check_violation THEN
    INSERT INTO _fa_check (item, ok, detail) VALUES ('不認得的課稅方式被擋（23514）', true, SQLSTATE);
  END;

  -- 4d. 迄日早於起日 → 23514
  BEGIN
    INSERT INTO public.employee_fixed_allowances (tenant_id, employee_id, name, amount, effective_from, effective_to) VALUES (t, e, 'x', 1, '2030-03-01', '2030-02-28');
    INSERT INTO _fa_check (item, ok, detail) VALUES ('迄日早於起日被擋（23514）', false, '竟然寫入成功');
  EXCEPTION WHEN check_violation THEN
    INSERT INTO _fa_check (item, ok, detail) VALUES ('迄日早於起日被擋（23514）', true, SQLSTATE);
  END;

  -- 4e. 名稱空白 → 23514
  BEGIN
    INSERT INTO public.employee_fixed_allowances (tenant_id, employee_id, name, amount, effective_from) VALUES (t, e, '   ', 1, '2030-01-01');
    INSERT INTO _fa_check (item, ok, detail) VALUES ('空白名稱被擋（23514）', false, '竟然寫入成功');
  EXCEPTION WHEN check_violation THEN
    INSERT INTO _fa_check (item, ok, detail) VALUES ('空白名稱被擋（23514）', true, SQLSTATE);
  END;

  -- 4f. 不存在的員工 → 23503
  BEGIN
    INSERT INTO public.employee_fixed_allowances (tenant_id, employee_id, name, amount, effective_from) VALUES (t, gen_random_uuid(), 'x', 1, '2030-01-01');
    INSERT INTO _fa_check (item, ok, detail) VALUES ('不存在的員工被擋（23503）', false, '竟然寫入成功');
  EXCEPTION WHEN foreign_key_violation THEN
    INSERT INTO _fa_check (item, ok, detail) VALUES ('不存在的員工被擋（23503）', true, SQLSTATE);
  END;

  -- 4g. salary_structures：新列預設適用新制、提繳工資 NULL；提繳工資 0 → 23514
  INSERT INTO public.salary_structures (tenant_id, employee_id) VALUES (t, e);
  SELECT coalesce(pension_wage::text, 'null') || '/' || pension_new_system::text INTO got FROM public.salary_structures WHERE employee_id = e;
  INSERT INTO _fa_check (item, ok, detail) VALUES ('salary_structures 新列預設 pension_wage NULL／適用新制', got = 'null/true', got);
  BEGIN
    UPDATE public.salary_structures SET pension_wage = 0 WHERE employee_id = e;
    INSERT INTO _fa_check (item, ok, detail) VALUES ('提繳工資 0 被擋（23514）', false, '竟然更新成功');
  EXCEPTION WHEN check_violation THEN
    INSERT INTO _fa_check (item, ok, detail) VALUES ('提繳工資 0 被擋（23514）', true, SQLSTATE);
  END;
  UPDATE public.salary_structures SET pension_wage = 45800, pension_new_system = false WHERE employee_id = e;
  SELECT pension_wage::text || '/' || pension_new_system::text INTO got FROM public.salary_structures WHERE employee_id = e;
  INSERT INTO _fa_check (item, ok, detail) VALUES ('提繳工資 45800、不適用新制可寫入', got = '45800/false', got);
END $$;
SELECT item, ok, detail FROM _fa_check ORDER BY seq;
ROLLBACK;

-- 5. 欄位數（目視參考）：payslips 不變；salary_structures 比套用前多 2（pension_wage、pension_new_system）
SELECT 'payslips' AS table_name, count(*) AS columns FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'payslips'
UNION ALL
SELECT 'salary_structures', count(*) FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'salary_structures';
