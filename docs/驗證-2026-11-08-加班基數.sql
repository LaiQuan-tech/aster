-- 2026-11-08 加班費時薪基數（migration 0087 ＝ sql/0077）套用後驗證。可重跑；交易內實測最後 ROLLBACK，不留資料。
-- ok 欄全為 true 才算通過。

-- 1. 欄位存在、boolean、NOT NULL、預設 true
SELECT count(*) = 1 AS ok, string_agg(data_type || ':' || is_nullable || ':' || coalesce(column_default, ''), ',') AS detail,
       'employee_fixed_allowances.overtime_base boolean NOT NULL DEFAULT true' AS item
  FROM information_schema.columns
 WHERE table_schema = 'public' AND table_name = 'employee_fixed_allowances' AND column_name = 'overtime_base'
   AND data_type = 'boolean' AND is_nullable = 'NO' AND column_default = 'true';

-- 2. 交易內實測：不帶欄位新增 → true；可改成 false；NULL 被擋
BEGIN;
CREATE TEMP TABLE _ob_check (seq serial, item text, ok boolean, detail text) ON COMMIT DROP;
DO $$
DECLARE t uuid; e uuid; a uuid; got text;
BEGIN
  INSERT INTO public.tenants (name) VALUES ('驗證用租戶（會 ROLLBACK）') RETURNING id INTO t;
  INSERT INTO public.employees (tenant_id, name) VALUES (t, '驗證用員工') RETURNING id INTO e;
  INSERT INTO public.employee_fixed_allowances (tenant_id, employee_id, name, amount, effective_from)
    VALUES (t, e, '驗證津貼', 1000, '2030-01-01') RETURNING id INTO a;
  SELECT overtime_base::text INTO got FROM public.employee_fixed_allowances WHERE id = a;
  INSERT INTO _ob_check (item, ok, detail) VALUES ('新列預設計入加班基數', got = 'true', got);
  UPDATE public.employee_fixed_allowances SET overtime_base = false WHERE id = a;
  SELECT overtime_base::text INTO got FROM public.employee_fixed_allowances WHERE id = a;
  INSERT INTO _ob_check (item, ok, detail) VALUES ('可改為不計入', got = 'false', got);
  BEGIN
    UPDATE public.employee_fixed_allowances SET overtime_base = NULL WHERE id = a;
    INSERT INTO _ob_check (item, ok, detail) VALUES ('NULL 被擋（23502）', false, '竟然更新成功');
  EXCEPTION WHEN not_null_violation THEN
    INSERT INTO _ob_check (item, ok, detail) VALUES ('NULL 被擋（23502）', true, SQLSTATE);
  END;
END $$;
SELECT item, ok, detail FROM _ob_check ORDER BY seq;
ROLLBACK;
