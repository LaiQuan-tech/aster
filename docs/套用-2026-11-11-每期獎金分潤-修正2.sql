-- 2026-11-11 每期款獎金分潤修正 2（migration 0093 ＝ sql/0083）：batch 期別列 FOR SHARE 鎖＋代墊款允許清除；
--   新觸發器 project_billings_bonus_shares_guard（期別軟刪除／改代墊款時該期還有分潤或發獎金日 → BS409）。
-- 前提：已套 0092（sql/0082，docs/套用-2026-11-11-每期獎金分潤-修正.sql）。只有函式與觸發器（CREATE OR REPLACE／DROP TRIGGER IF EXISTS）、
--   冪等、包在交易內；不動任何資料列。
-- 套用後跑 docs/驗證-2026-11-11-每期獎金分潤-修正2.sql（正式庫只跑第 1 段唯讀檢查）。
-- 已用 `npm run db:replay -- --base-migration 53 --base-sql 62 --base-file docs/套用-2026-11-08-薪資津貼勞退.sql
--   --base-file docs/套用-2026-11-08-加班基數.sql --base-file docs/套用-2026-11-10-薪資投保歷程.sql
--   --base-file docs/套用-2026-11-10-副委託事務所與發票.sql --base-file docs/套用-2026-11-10-申請單版本.sql
--   --base-file docs/套用-2026-11-11-每期獎金分潤.sql --base-file docs/套用-2026-11-11-每期獎金分潤-修正.sql
--   docs/套用-2026-11-11-每期獎金分潤-修正2.sql --verify docs/驗證-2026-11-11-每期獎金分潤-修正2.sql
--   --verify docs/驗證-2026-11-11-每期獎金分潤-修正.sql --verify docs/驗證-2026-11-11-每期獎金分潤.sql` 在 pglite 上套兩遍（驗冪等）＋驗證全部通過。
BEGIN;

-- 2026-11-11 每期款獎金分潤修正 2（接 0092 ＝ sql/0082）：刪期別／改代墊款與分潤寫入的時序漏洞＋代墊款舊資料自救。
--   set_billing_bonus_shares_batch（CREATE OR REPLACE，簽章／security definer／search_path／權限不變）：
--     step 3 先以 FOR SHARE 鎖住要寫的期別列（依 id 排序）再檢查「存在、未刪、非代墊款」，
--       與同時進行的期別軟刪除／改代墊款互相排隊，不會寫到剛被刪掉的期別上。
--     代墊款期別（guild_advance）允許「清除」：shares 空陣列且 bonus_paid_on null（舊資料自救）；要寫入非空仍擋 22023。
--   project_billings_bonus_shares_guard（新觸發器，BEFORE UPDATE OF deleted_at, kind）：
--     deleted_at 由 null → 非 null（軟刪除），或 kind 改成 'guild_advance' 時，若該期還有 project_billing_shares 或
--     project_billing_bonus_dates 列 → RAISE ERRCODE 'BS409'（API 對應成 409 billing_has_bonus_shares）。
--     觸發器函式 security definer＋固定 search_path（兩張分潤表 RLS 開、無 policy：以表擁有者身分讀，不受呼叫者 RLS 影響）；
--     WHEN 條件只在這兩種轉變時才執行，其他欄位更新與既有 audit_all（AFTER 觸發器）不受影響。
-- 前提：已套到 0092（sql/0082）。不動任何資料列；可重跑（CREATE OR REPLACE／DROP TRIGGER IF EXISTS）。
-- 函式 revoke PUBLIC／anon／authenticated；batch 只給 service_role。
CREATE OR REPLACE FUNCTION public.set_billing_bonus_shares_batch(
  p_tenant_id uuid,
  p_project_id uuid,
  p_items jsonb,
  p_actor_emp_id uuid
) RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_now timestamptz := now();
  v_total integer := 0;
  v_count integer;
  v_bad integer;
  v_item record;
  v_uuid_re constant text := '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
BEGIN
  IF p_items IS NULL OR jsonb_typeof(p_items) <> 'array' OR jsonb_array_length(p_items) = 0 THEN
    RAISE EXCEPTION 'set_billing_bonus_shares_batch: items must be a non-empty array' USING ERRCODE = '22023';
  END IF;

  -- 1. 形狀：每期是物件、billing_id 是 uuid、shares 是陣列、bonus_paid_on 是 null 或 YYYY-MM-DD 字串。
  SELECT count(*) INTO v_bad
    FROM jsonb_array_elements(p_items) AS i(v)
   WHERE CASE
           WHEN jsonb_typeof(i.v) IS DISTINCT FROM 'object' THEN true
           WHEN (i.v ->> 'billing_id') IS NULL OR (i.v ->> 'billing_id') !~* v_uuid_re THEN true
           WHEN jsonb_typeof(i.v -> 'shares') IS DISTINCT FROM 'array' THEN true
           WHEN coalesce(jsonb_typeof(i.v -> 'bonus_paid_on'), 'null') NOT IN ('null', 'string') THEN true
           WHEN jsonb_typeof(i.v -> 'bonus_paid_on') = 'string' AND (i.v ->> 'bonus_paid_on') !~ '^\d{4}-\d{2}-\d{2}$' THEN true
           ELSE false
         END;
  IF v_bad > 0 THEN
    RAISE EXCEPTION 'set_billing_bonus_shares_batch: invalid item' USING ERRCODE = '22023';
  END IF;
  SELECT count(*) - count(DISTINCT (i.v ->> 'billing_id')::uuid) INTO v_bad FROM jsonb_array_elements(p_items) AS i(v);
  IF v_bad > 0 THEN
    RAISE EXCEPTION 'set_billing_bonus_shares_batch: duplicate billing' USING ERRCODE = '22023';
  END IF;
  -- 每一列分潤：物件、employee_id 是 uuid、amount 是 ≥ 0 的數字。
  SELECT count(*) INTO v_bad
    FROM jsonb_array_elements(p_items) AS i(v)
    CROSS JOIN LATERAL jsonb_array_elements(i.v -> 'shares') AS s(v)
   WHERE CASE
           WHEN jsonb_typeof(s.v) IS DISTINCT FROM 'object' THEN true
           WHEN jsonb_typeof(s.v -> 'amount') IS DISTINCT FROM 'number' THEN true
           WHEN (s.v ->> 'amount')::numeric < 0 THEN true
           WHEN (s.v ->> 'employee_id') IS NULL THEN true
           ELSE (s.v ->> 'employee_id') !~* v_uuid_re
         END;
  IF v_bad > 0 THEN
    RAISE EXCEPTION 'set_billing_bonus_shares_batch: invalid share row' USING ERRCODE = '22023';
  END IF;
  -- 發獎金日要是合法日期（2026-02-30 這種先在這裡擋，不要寫到一半才失敗）。
  PERFORM (i.v ->> 'bonus_paid_on')::date
     FROM jsonb_array_elements(p_items) AS i(v)
    WHERE jsonb_typeof(i.v -> 'bonus_paid_on') = 'string';

  -- 2. 鎖：依期別 id 排序逐一取（多期同時寫不互鎖；交易結束自動釋放）。
  PERFORM pg_advisory_xact_lock(hashtext('billing_shares:' || x.id::text))
     FROM (SELECT DISTINCT (i.v ->> 'billing_id')::uuid AS id FROM jsonb_array_elements(p_items) AS i(v) ORDER BY 1) AS x;

  -- 3. 先鎖期別列（FOR SHARE，依 id 排序）：同時有人軟刪除期別或改成代墊款時，兩邊排隊——
  --    對方先 → 這裡等它提交後重新檢查（已刪 → P0002、已是代墊款 → 22023）；這裡先 → 對方的 UPDATE 等本交易提交，
  --    再由 project_billings_bonus_shares_guard 觸發器看到新寫入的分潤而擋下（BS409）。
  PERFORM 1
     FROM public.project_billings b
    WHERE b.id IN (SELECT DISTINCT (i.v ->> 'billing_id')::uuid FROM jsonb_array_elements(p_items) AS i(v))
      AND b.tenant_id = p_tenant_id AND b.project_id = p_project_id
    ORDER BY b.id
      FOR SHARE OF b;
  --    全部期別存在、屬此租戶此專案、未刪；不是代墊款（代墊款只允許「清除」：shares 空＋發獎金日 null，舊資料自救）。
  SELECT count(*) INTO v_bad
    FROM jsonb_array_elements(p_items) AS i(v)
   WHERE NOT EXISTS (
     SELECT 1 FROM public.project_billings b
      WHERE b.id = (i.v ->> 'billing_id')::uuid AND b.tenant_id = p_tenant_id AND b.project_id = p_project_id AND b.deleted_at IS NULL
   );
  IF v_bad > 0 THEN
    RAISE EXCEPTION 'set_billing_bonus_shares_batch: billing not found' USING ERRCODE = 'P0002';
  END IF;
  SELECT count(*) INTO v_bad
    FROM jsonb_array_elements(p_items) AS i(v)
    JOIN public.project_billings b ON b.id = (i.v ->> 'billing_id')::uuid
   WHERE b.kind = 'guild_advance'
     AND (jsonb_array_length(i.v -> 'shares') > 0 OR jsonb_typeof(i.v -> 'bonus_paid_on') = 'string');
  IF v_bad > 0 THEN
    RAISE EXCEPTION 'set_billing_bonus_shares_batch: advance billing cannot have shares' USING ERRCODE = '22023';
  END IF;

  -- 4. 同一期不重複員工；全部員工屬此租戶。
  SELECT count(*) - count(DISTINCT ((i.v ->> 'billing_id')::uuid, (s.v ->> 'employee_id')::uuid)) INTO v_bad
    FROM jsonb_array_elements(p_items) AS i(v)
    CROSS JOIN LATERAL jsonb_array_elements(i.v -> 'shares') AS s(v);
  IF v_bad > 0 THEN
    RAISE EXCEPTION 'set_billing_bonus_shares_batch: duplicate employee' USING ERRCODE = '22023';
  END IF;
  SELECT count(*) INTO v_bad
    FROM jsonb_array_elements(p_items) AS i(v)
    CROSS JOIN LATERAL jsonb_array_elements(i.v -> 'shares') AS s(v)
   WHERE NOT EXISTS (SELECT 1 FROM public.employees e WHERE e.id = (s.v ->> 'employee_id')::uuid AND e.tenant_id = p_tenant_id);
  IF v_bad > 0 THEN
    RAISE EXCEPTION 'set_billing_bonus_shares_batch: employee not in tenant' USING ERRCODE = '22023';
  END IF;

  -- 5. 全部合法 → 逐期整批換掉。
  FOR v_item IN
    SELECT (i.v ->> 'billing_id')::uuid AS billing_id,
           CASE WHEN jsonb_typeof(i.v -> 'bonus_paid_on') = 'string' THEN (i.v ->> 'bonus_paid_on')::date END AS bonus_paid_on,
           i.v -> 'shares' AS shares
      FROM jsonb_array_elements(p_items) AS i(v)
  LOOP
    DELETE FROM public.project_billing_shares WHERE tenant_id = p_tenant_id AND billing_id = v_item.billing_id;
    INSERT INTO public.project_billing_shares (tenant_id, project_id, billing_id, employee_id, amount, note, created_by, created_at, updated_at)
    SELECT p_tenant_id, p_project_id, v_item.billing_id, (s.v ->> 'employee_id')::uuid, (s.v ->> 'amount')::numeric,
           nullif(btrim(coalesce(s.v ->> 'note', '')), ''), p_actor_emp_id, v_now, v_now
      FROM jsonb_array_elements(v_item.shares) AS s(v);
    GET DIAGNOSTICS v_count = ROW_COUNT;
    v_total := v_total + v_count;

    IF v_item.bonus_paid_on IS NULL THEN
      DELETE FROM public.project_billing_bonus_dates WHERE tenant_id = p_tenant_id AND billing_id = v_item.billing_id;
    ELSE
      INSERT INTO public.project_billing_bonus_dates (billing_id, tenant_id, project_id, bonus_paid_on, created_by, created_at, updated_at)
      VALUES (v_item.billing_id, p_tenant_id, p_project_id, v_item.bonus_paid_on, p_actor_emp_id, v_now, v_now)
      ON CONFLICT (billing_id) DO UPDATE SET bonus_paid_on = EXCLUDED.bonus_paid_on, updated_at = v_now;
    END IF;

    -- 稽核摘要：不含金額、人名、日期（分潤屬集團財務，HR 看得到稽核）。
    INSERT INTO public.audit_logs (tenant_id, table_name, record_id, action, old_row, new_row, db_user, actor_emp_id, context)
    VALUES (p_tenant_id, 'project_billing_shares', v_item.billing_id, 'UPDATE', NULL,
            jsonb_build_object('project_id', p_project_id, 'billing_id', v_item.billing_id, 'people', v_count,
                               'has_bonus_paid_on', v_item.bonus_paid_on IS NOT NULL),
            current_user, p_actor_emp_id, 'set_billing_bonus_shares');
  END LOOP;
  RETURN v_total;
END;
$$;

REVOKE ALL ON FUNCTION public.set_billing_bonus_shares_batch(uuid, uuid, jsonb, uuid) FROM PUBLIC;
DO $$ BEGIN
  REVOKE ALL ON FUNCTION public.set_billing_bonus_shares_batch(uuid, uuid, jsonb, uuid) FROM anon, authenticated;
EXCEPTION WHEN undefined_object THEN NULL; END $$;
DO $$ BEGIN
  GRANT EXECUTE ON FUNCTION public.set_billing_bonus_shares_batch(uuid, uuid, jsonb, uuid) TO service_role;
EXCEPTION WHEN undefined_object THEN NULL; END $$;

REVOKE ALL ON FUNCTION public.set_billing_bonus_shares_batch(uuid, uuid, jsonb, uuid) FROM PUBLIC;
DO $$ BEGIN
  REVOKE ALL ON FUNCTION public.set_billing_bonus_shares_batch(uuid, uuid, jsonb, uuid) FROM anon, authenticated;
EXCEPTION WHEN undefined_object THEN NULL; END $$;
DO $$ BEGIN
  GRANT EXECUTE ON FUNCTION public.set_billing_bonus_shares_batch(uuid, uuid, jsonb, uuid) TO service_role;
EXCEPTION WHEN undefined_object THEN NULL; END $$;

-- 期別軟刪除／改成代墊款時，該期不可還有獎金分潤或發獎金日。
CREATE OR REPLACE FUNCTION public.project_billings_bonus_shares_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.project_billing_shares s WHERE s.billing_id = NEW.id)
     OR EXISTS (SELECT 1 FROM public.project_billing_bonus_dates d WHERE d.billing_id = NEW.id) THEN
    RAISE EXCEPTION 'project_billings: billing has bonus shares (%)',
      CASE WHEN OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL THEN 'delete' ELSE 'kind' END
      USING ERRCODE = 'BS409';
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.project_billings_bonus_shares_guard() FROM PUBLIC;
DO $$ BEGIN
  REVOKE ALL ON FUNCTION public.project_billings_bonus_shares_guard() FROM anon, authenticated;
EXCEPTION WHEN undefined_object THEN NULL; END $$;

DROP TRIGGER IF EXISTS project_billings_bonus_shares_guard ON public.project_billings;
CREATE TRIGGER project_billings_bonus_shares_guard
  BEFORE UPDATE OF deleted_at, kind ON public.project_billings
  FOR EACH ROW
  WHEN ((OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL)
        OR (NEW.kind = 'guild_advance' AND OLD.kind IS DISTINCT FROM 'guild_advance'))
  EXECUTE FUNCTION public.project_billings_bonus_shares_guard();

COMMIT;
