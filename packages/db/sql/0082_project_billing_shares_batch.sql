-- 2026-11-11 每期款獎金分潤修正（接 0091 ＝ sql/0081）：多期一次寫入「全成全敗」＋代墊款期別不可設分潤。
--   set_billing_bonus_shares_batch(p_tenant_id, p_project_id, p_items, p_actor_emp_id)：
--     p_items：[{"billing_id": uuid, "bonus_paid_on": "YYYY-MM-DD"|null, "shares": [{"employee_id": uuid, "amount": number, "note": text|null}, …]}, …]
--     同一交易內先驗完**所有**期別（屬於該租戶該專案且未刪、不是代墊款 guild_advance、期別不重複）、
--     所有分潤列（員工屬於該租戶、金額 ≥ 0 的數字、同一期不重複），全部合法才逐期整批換掉；任何一期不合法 → 整批回滾。
--     依期別 id 排序取 advisory lock（同一期的寫入排隊、多期同時寫不互鎖）。每期寫一筆**不含金額與人名**的稽核摘要。
--     回傳寫入後的總人數。錯誤碼：P0002 期別不存在／不屬此租戶此專案／已刪；22023 參數不合法（含代墊款期別、別租戶員工、重複）。
--   set_billing_bonus_shares(…6 個參數…)：簽章不變（CREATE OR REPLACE，security definer／search_path／權限不變），
--     改成包一層呼叫 batch（單期），兩個入口規則一致（舊版 API 部署前後都能用）。
--   「分潤合計 ≤ 該期金額」仍由 API 檢查（期別有效金額要依合約試算，見 apps/api routes/billing-shares.ts）。
-- 前提：已套到 0091（sql/0081）。不動任何表或資料；可重跑（CREATE OR REPLACE）。
-- 函式 revoke PUBLIC／anon／authenticated，只給 service_role。
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

  -- 3. 全部期別存在、屬此租戶此專案、未刪；不是代墊款。
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
   WHERE b.kind = 'guild_advance';
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

-- 舊的單期入口：簽章不變，改成呼叫 batch（規則一致：代墊款也擋）。
CREATE OR REPLACE FUNCTION public.set_billing_bonus_shares(
  p_tenant_id uuid,
  p_project_id uuid,
  p_billing_id uuid,
  p_bonus_paid_on date,
  p_shares jsonb,
  p_actor_emp_id uuid
) RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF p_shares IS NULL OR jsonb_typeof(p_shares) <> 'array' THEN
    RAISE EXCEPTION 'set_billing_bonus_shares: shares must be an array' USING ERRCODE = '22023';
  END IF;
  -- 鎖在 batch 裡取（pg_advisory_xact_lock）。
  RETURN public.set_billing_bonus_shares_batch(
    p_tenant_id, p_project_id,
    jsonb_build_array(jsonb_build_object('billing_id', p_billing_id, 'bonus_paid_on', p_bonus_paid_on, 'shares', p_shares)),
    p_actor_emp_id);
END;
$$;

REVOKE ALL ON FUNCTION public.set_billing_bonus_shares(uuid, uuid, uuid, date, jsonb, uuid) FROM PUBLIC;
DO $$ BEGIN
  REVOKE ALL ON FUNCTION public.set_billing_bonus_shares(uuid, uuid, uuid, date, jsonb, uuid) FROM anon, authenticated;
EXCEPTION WHEN undefined_object THEN NULL; END $$;
DO $$ BEGIN
  GRANT EXECUTE ON FUNCTION public.set_billing_bonus_shares(uuid, uuid, uuid, date, jsonb, uuid) TO service_role;
EXCEPTION WHEN undefined_object THEN NULL; END $$;
