-- 2026-11-10 副委託事務所與發票（migration 0089 ＝ sql/0079）套用後驗證。唯讀＋交易內實測（最後 ROLLBACK，不留任何資料）。
-- 每一段回一張表；ok 欄全為 true 才算通過。

-- 1. 三個新欄位與型別（皆可空）
SELECT count(*) = 3 AS ok, string_agg(column_name || ':' || data_type, ', ' ORDER BY column_name) AS columns
  FROM information_schema.columns
 WHERE table_schema = 'public' AND table_name = 'project_subcontracts' AND is_nullable = 'YES'
   AND (column_name, data_type) IN (('withholding_date','date'), ('invoice_no','text'), ('invoice_date','date'));

-- 2. kind CHECK 已含 firm；invoice_no 長度 CHECK 存在
SELECT pg_get_constraintdef(oid) LIKE '%firm%' AS ok, 'project_subcontracts_kind_chk 含 firm' AS item
  FROM pg_constraint WHERE conrelid = 'public.project_subcontracts'::regclass AND conname = 'project_subcontracts_kind_chk';
SELECT count(*) = 1 AS ok, 'project_subcontracts_invoice_no_chk 存在' AS item
  FROM pg_constraint WHERE conrelid = 'public.project_subcontracts'::regclass AND conname = 'project_subcontracts_invoice_no_chk';

-- 3. 既有資料沒有違反新約束的列（kind 只會是三種之一）
SELECT count(*) = 0 AS ok, 'kind 皆在允許集合內' AS item
  FROM public.project_subcontracts WHERE kind NOT IN ('subcontract', 'technician', 'firm');

-- 4. 交易內實測：firm 可寫入、未知類型與過長發票號碼被擋（最後 ROLLBACK）
BEGIN;
DO $$
DECLARE v_id uuid;
BEGIN
  SELECT id INTO v_id FROM public.project_subcontracts LIMIT 1;
  IF v_id IS NULL THEN
    RAISE NOTICE '沒有副委託資料，略過寫入實測';
    RETURN;
  END IF;
  UPDATE public.project_subcontracts SET kind = 'firm', withholding_date = DATE '2026-11-10' WHERE id = v_id;
  BEGIN
    UPDATE public.project_subcontracts SET kind = 'bogus' WHERE id = v_id;
    RAISE EXCEPTION 'kind CHECK 沒擋住 bogus';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    UPDATE public.project_subcontracts SET invoice_no = repeat('A', 41) WHERE id = v_id;
    RAISE EXCEPTION 'invoice_no CHECK 沒擋住 41 字';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
END $$;
SELECT true AS ok, '寫入實測通過（未拋例外）' AS item;
ROLLBACK;
