-- 2026-11-10 調薪歷程＋勞健保調整歷程（migration 0088 ＝ sql/0078）套用後驗證。唯讀＋交易內實測（最後 ROLLBACK，不留任何資料）。
-- 每一段回一張表；ok 欄全為 true 才算通過。

-- 1. insured_salary_changes 存在、RLS 開、掛 audit_all、沒有任何 policy（只由 API service role 存取）
SELECT c.relname AS table_name,
       (c.relrowsecurity
        AND EXISTS (SELECT 1 FROM pg_trigger t WHERE t.tgrelid = c.oid AND t.tgname = 'audit_all' AND NOT t.tgisinternal)
        AND NOT EXISTS (SELECT 1 FROM pg_policies p WHERE p.schemaname = 'public' AND p.tablename = c.relname)) AS ok
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname = 'public' AND c.relname = 'insured_salary_changes';

SELECT count(*) = 1 AS ok, 'insured_salary_changes 存在' AS item
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relname = 'insured_salary_changes';

-- 2. 欄位與型別
SELECT count(*) = 14 AS ok, string_agg(column_name || ':' || data_type, ', ' ORDER BY ordinal_position) AS columns
  FROM information_schema.columns
 WHERE table_schema = 'public' AND table_name = 'insured_salary_changes'
   AND (column_name, data_type) IN (
     ('id','uuid'), ('tenant_id','uuid'), ('employee_id','uuid'), ('effective_on','date'),
     ('labor_insured_salary','integer'), ('health_insured_salary','integer'), ('pension_wage','integer'),
     ('prev_labor_insured_salary','integer'), ('prev_health_insured_salary','integer'), ('prev_pension_wage','integer'),
     ('note','text'), ('created_by_emp_id','uuid'), ('created_at','timestamp with time zone'), ('deleted_at','timestamp with time zone')
   );

-- 3. CHECK、索引；salary_adjustments.prev_salary（numeric、可空）；salary_adjustments 仍掛 audit_all
SELECT count(*) = 2 AS ok, string_agg(conname, ', ' ORDER BY conname) AS checks
  FROM pg_constraint
 WHERE conrelid = 'public.insured_salary_changes'::regclass AND contype = 'c'
   AND conname IN ('insured_salary_changes_amounts_chk', 'insured_salary_changes_note_chk');
SELECT EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'insured_salary_changes_tenant_emp_idx') AS ok,
       'index insured_salary_changes_tenant_emp_idx' AS item;
SELECT count(*) = 1 AS ok, 'salary_adjustments.prev_salary numeric NULL' AS item
  FROM information_schema.columns
 WHERE table_schema = 'public' AND table_name = 'salary_adjustments' AND column_name = 'prev_salary'
   AND data_type = 'numeric' AND is_nullable = 'YES';
SELECT EXISTS (SELECT 1 FROM pg_trigger t WHERE t.tgrelid = 'public.salary_adjustments'::regclass AND t.tgname = 'audit_all' AND NOT t.tgisinternal) AS ok,
       'salary_adjustments 掛 audit_all' AS item;

-- 4. 交易內實測（ROLLBACK）
BEGIN;
CREATE TEMP TABLE _ish_check (seq serial, item text, ok boolean, detail text) ON COMMIT DROP;
DO $$
DECLARE t uuid; e uuid; a uuid; got text; n int;
BEGIN
  INSERT INTO public.tenants (name) VALUES ('驗證用租戶（會 ROLLBACK）') RETURNING id INTO t;
  INSERT INTO public.employees (tenant_id, name) VALUES (t, '驗證用員工') RETURNING id INTO e;

  INSERT INTO public.insured_salary_changes (tenant_id, employee_id, effective_on, labor_insured_salary, prev_labor_insured_salary, note)
    VALUES (t, e, '2030-04-21', 38200, 33000, '驗證') RETURNING id INTO a;
  SELECT prev_labor_insured_salary || '→' || labor_insured_salary INTO got FROM public.insured_salary_changes WHERE id = a;
  INSERT INTO _ish_check (item, ok, detail) VALUES ('合法列寫入（原→新）', got = '33000→38200', got);

  SELECT count(*) INTO n FROM public.audit_logs WHERE table_name = 'insured_salary_changes' AND record_id = a;
  INSERT INTO _ish_check (item, ok, detail) VALUES ('寫入有 audit_logs', n >= 1, n::text);

  BEGIN
    INSERT INTO public.insured_salary_changes (tenant_id, employee_id, effective_on, labor_insured_salary) VALUES (t, e, '2030-01-01', -1);
    INSERT INTO _ish_check (item, ok, detail) VALUES ('負金額被擋（23514）', false, '竟然寫入成功');
  EXCEPTION WHEN check_violation THEN
    INSERT INTO _ish_check (item, ok, detail) VALUES ('負金額被擋（23514）', true, SQLSTATE);
  END;

  BEGIN
    INSERT INTO public.insured_salary_changes (tenant_id, employee_id, labor_insured_salary) VALUES (t, e, 1);
    INSERT INTO _ish_check (item, ok, detail) VALUES ('生效日必填（23502）', false, '竟然寫入成功');
  EXCEPTION WHEN not_null_violation THEN
    INSERT INTO _ish_check (item, ok, detail) VALUES ('生效日必填（23502）', true, SQLSTATE);
  END;

  INSERT INTO public.salary_adjustments (tenant_id, employee_id, effective_date, new_salary, prev_salary, reason)
    VALUES (t, e, '2030-04-21', 38000, 33000, '驗證') RETURNING id INTO a;
  SELECT prev_salary || '→' || new_salary INTO got FROM public.salary_adjustments WHERE id = a;
  INSERT INTO _ish_check (item, ok, detail) VALUES ('salary_adjustments 可寫 prev_salary', got = '33000→38000', got);
END $$;
SELECT item, ok, detail FROM _ish_check ORDER BY seq;
ROLLBACK;
