-- 2026-11-19 每期款獎金：本期獎金／算法說明、專案獎金上限、季獎金自動帶入（本檔 ＝ sql/0109 ＝ migration 0119；接 0118 ＝ sql/0108）。
--
-- 業主決定（2026-11-19）：
--   1. 每期加「本期獎金」（手填金額，可 0）＋「算法說明」（例「30萬＋20萬×10%」，200 字內）：
--      存在 project_billing_bonus_dates（一期一列）新欄 bonus_amount／formula_note；bonus_paid_on 改為可空
--      （只填本期獎金、還沒定發獎金日的期別也要能存）。「＋設定」分給成員的合計 ≤ 本期獎金；本期獎金未填時
--      沿用舊規則（≤ 該期金額，API 檢查）以相容舊資料。
--   2. 專案獎金上限 ＝ 合約金額（未稅）× 上限比例：projects.bonus_rate_pct 是**含稅制**比率（Excel 制：含稅入帳／
--      含稅合約 × 比例，見 apps/api services/bonus-run.ts projectBonusBasisOf），不能拿來乘未稅合約，所以另開
--      project_billing_bonus_caps（一案一列 cap_pct）。不放在 projects 上：projects 掛 audit_all，HR 看得到稽核。
--   3. 季獎金自動偵測：發獎金日 ≤ 某季季末、有分給成員、尚未發放的每期分潤，在季獎金批次建立／重算時自動帶入，
--      凍結在 bonus_run_billing_items（批次 × 期別 × 員工一列，金額＝該期該員分配額）。批次 paid ＝ 已發；
--      沖銷批次寫負數列，淨額歸零＝解鎖、下一季重新帶入。季獎金原本的 bonus_run_items（比例制）完全不動。
--   4. 已發的期別（淨額 ≠ 0）鎖定：set_billing_bonus_shares_batch 擋下改人／改金額／改本期獎金／改發獎金日（BL409），
--      說明文字（formula_note、分潤備註）仍可改。
--   5. 刪除專案：bonus_run_billing_items（任何狀態的批次）也擋刪（同 bonus_run_items）；本期獎金存在
--      project_billing_bonus_dates，原本就擋。
-- 稽核：三張表（含新欄）都不掛 audit_all（同 0091 理由：分潤屬集團財務，HR 看得到稽核）；寫入函式只寫不含金額的摘要。
-- 權限：RLS 開、不給 policy、revoke anon／authenticated；函式 revoke PUBLIC／anon／authenticated，只給 service_role，
--   security definer＋固定 search_path。
-- 前提：已套 0118（sql/0108）。只加欄／加表／CREATE OR REPLACE 函式（RETURNS 形狀不變），不動任何既有資料列；可重跑。

-- ── 1. 本期獎金／算法說明 ─────────────────────────────────────────────
ALTER TABLE public.project_billing_bonus_dates ALTER COLUMN bonus_paid_on DROP NOT NULL;
ALTER TABLE public.project_billing_bonus_dates ADD COLUMN IF NOT EXISTS bonus_amount numeric(14,2);
ALTER TABLE public.project_billing_bonus_dates ADD COLUMN IF NOT EXISTS formula_note text;
DO $$ BEGIN
  ALTER TABLE public.project_billing_bonus_dates ADD CONSTRAINT project_billing_bonus_dates_amount_chk
    CHECK (bonus_amount IS NULL OR bonus_amount >= 0);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE public.project_billing_bonus_dates ADD CONSTRAINT project_billing_bonus_dates_formula_chk
    CHECK (formula_note IS NULL OR char_length(formula_note) <= 200);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── 2. 專案獎金上限比例 ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.project_billing_bonus_caps (
  project_id uuid PRIMARY KEY REFERENCES public.projects(id),
  tenant_id uuid NOT NULL REFERENCES public.tenants(id),
  cap_pct numeric(6,3) NOT NULL,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS project_billing_bonus_caps_tenant_idx ON public.project_billing_bonus_caps (tenant_id);
DO $$ BEGIN
  ALTER TABLE public.project_billing_bonus_caps ADD CONSTRAINT project_billing_bonus_caps_pct_chk CHECK (cap_pct >= 0 AND cap_pct <= 100);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── 3. 季獎金批次帶入的每期分潤（凍結列） ─────────────────────────────
CREATE TABLE IF NOT EXISTS public.bonus_run_billing_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  run_id uuid NOT NULL REFERENCES public.bonus_runs(id),
  project_id uuid NOT NULL REFERENCES public.projects(id),
  billing_id uuid NOT NULL REFERENCES public.project_billings(id),
  employee_id uuid NOT NULL REFERENCES public.employees(id),
  amount numeric(14,2) NOT NULL,
  bonus_paid_on date,
  snapshot jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS bonus_run_billing_items_run_billing_emp_uq
  ON public.bonus_run_billing_items (run_id, billing_id, employee_id);
CREATE INDEX IF NOT EXISTS bonus_run_billing_items_tenant_billing_idx ON public.bonus_run_billing_items (tenant_id, billing_id);
CREATE INDEX IF NOT EXISTS bonus_run_billing_items_tenant_project_idx ON public.bonus_run_billing_items (tenant_id, project_id);
CREATE INDEX IF NOT EXISTS bonus_run_billing_items_tenant_employee_idx ON public.bonus_run_billing_items (tenant_id, employee_id);
-- 所屬批次 paid 後凍結（同 bonus_run_items，forbid_paid_bonus_mutation 以 OLD.run_id 查母批次狀態）。
DROP TRIGGER IF EXISTS forbid_paid_bonus_mutation ON public.bonus_run_billing_items;
CREATE TRIGGER forbid_paid_bonus_mutation
  BEFORE UPDATE OR DELETE ON public.bonus_run_billing_items
  FOR EACH ROW EXECUTE FUNCTION public.forbid_paid_bonus_mutation();

ALTER TABLE public.project_billing_bonus_caps ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.bonus_run_billing_items ENABLE ROW LEVEL SECURITY;
DROP TRIGGER IF EXISTS audit_all ON public.project_billing_bonus_caps;
DROP TRIGGER IF EXISTS audit_all ON public.bonus_run_billing_items;
DO $$ BEGIN
  REVOKE ALL ON TABLE public.project_billing_bonus_caps FROM anon, authenticated;
  REVOKE ALL ON TABLE public.bonus_run_billing_items FROM anon, authenticated;
EXCEPTION WHEN undefined_object THEN NULL; END $$;
DO $$ BEGIN
  GRANT ALL ON TABLE public.project_billing_bonus_caps TO service_role;
  GRANT ALL ON TABLE public.bonus_run_billing_items TO service_role;
EXCEPTION WHEN undefined_object THEN NULL; END $$;

-- ── 4. 寫入入口：set_billing_bonus_shares_batch（簽章／RETURNS integer 不變） ──────────────
-- p_items 每期多兩個**選填**鍵：bonus_amount（null 或 ≥ 0 的數字；鍵不存在＝沿用已存的）、
-- formula_note（null 或字串 ≤ 200 字；鍵不存在＝沿用已存的）。
-- 新錯誤碼：BS422 分給成員的合計超過本期獎金；BL409 期別已發放（季獎金批次 paid、淨額 ≠ 0）不可改人／金額／
-- 本期獎金／發獎金日。
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
  v_old record;
  v_amount numeric;
  v_formula text;
  v_locked boolean;
  v_uuid_re constant text := '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
BEGIN
  IF p_items IS NULL OR jsonb_typeof(p_items) <> 'array' OR jsonb_array_length(p_items) = 0 THEN
    RAISE EXCEPTION 'set_billing_bonus_shares_batch: items must be a non-empty array' USING ERRCODE = '22023';
  END IF;

  -- 1. 形狀：每期是物件、billing_id 是 uuid、shares 是陣列、bonus_paid_on 是 null 或 YYYY-MM-DD 字串、
  --    bonus_amount 是 null 或 ≥ 0 的數字、formula_note 是 null 或 ≤ 200 字的字串。
  SELECT count(*) INTO v_bad
    FROM jsonb_array_elements(p_items) AS i(v)
   WHERE CASE
           WHEN jsonb_typeof(i.v) IS DISTINCT FROM 'object' THEN true
           WHEN (i.v ->> 'billing_id') IS NULL OR (i.v ->> 'billing_id') !~* v_uuid_re THEN true
           WHEN jsonb_typeof(i.v -> 'shares') IS DISTINCT FROM 'array' THEN true
           WHEN coalesce(jsonb_typeof(i.v -> 'bonus_paid_on'), 'null') NOT IN ('null', 'string') THEN true
           WHEN jsonb_typeof(i.v -> 'bonus_paid_on') = 'string' AND (i.v ->> 'bonus_paid_on') !~ '^\d{4}-\d{2}-\d{2}$' THEN true
           WHEN coalesce(jsonb_typeof(i.v -> 'bonus_amount'), 'null') NOT IN ('null', 'number') THEN true
           WHEN jsonb_typeof(i.v -> 'bonus_amount') = 'number' AND (i.v ->> 'bonus_amount')::numeric < 0 THEN true
           WHEN coalesce(jsonb_typeof(i.v -> 'formula_note'), 'null') NOT IN ('null', 'string') THEN true
           WHEN jsonb_typeof(i.v -> 'formula_note') = 'string' AND char_length(i.v ->> 'formula_note') > 200 THEN true
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

  -- 3. 先鎖期別列（FOR SHARE，依 id 排序）：與期別軟刪除／改代墊款排隊（見 0093）。
  PERFORM 1
     FROM public.project_billings b
    WHERE b.id IN (SELECT DISTINCT (i.v ->> 'billing_id')::uuid FROM jsonb_array_elements(p_items) AS i(v))
      AND b.tenant_id = p_tenant_id AND b.project_id = p_project_id
    ORDER BY b.id
      FOR SHARE OF b;
  SELECT count(*) INTO v_bad
    FROM jsonb_array_elements(p_items) AS i(v)
   WHERE NOT EXISTS (
     SELECT 1 FROM public.project_billings b
      WHERE b.id = (i.v ->> 'billing_id')::uuid AND b.tenant_id = p_tenant_id AND b.project_id = p_project_id AND b.deleted_at IS NULL
   );
  IF v_bad > 0 THEN
    RAISE EXCEPTION 'set_billing_bonus_shares_batch: billing not found' USING ERRCODE = 'P0002';
  END IF;
  -- 代墊款只允許「清除」：shares 空、發獎金日 null、本期獎金 null/0、沒有算法說明（舊資料自救）。
  SELECT count(*) INTO v_bad
    FROM jsonb_array_elements(p_items) AS i(v)
    JOIN public.project_billings b ON b.id = (i.v ->> 'billing_id')::uuid
   WHERE b.kind = 'guild_advance'
     AND (jsonb_array_length(i.v -> 'shares') > 0 OR jsonb_typeof(i.v -> 'bonus_paid_on') = 'string'
          OR (jsonb_typeof(i.v -> 'bonus_amount') = 'number' AND (i.v ->> 'bonus_amount')::numeric > 0)
          OR (jsonb_typeof(i.v -> 'formula_note') = 'string' AND btrim(i.v ->> 'formula_note') <> ''));
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

  -- 5. 逐期：算出寫入後的本期獎金／算法說明（鍵不存在＝沿用）→ 合計 ≤ 本期獎金 → 已發放的期別只准改說明 → 整批換掉。
  FOR v_item IN
    SELECT (i.v ->> 'billing_id')::uuid AS billing_id,
           CASE WHEN jsonb_typeof(i.v -> 'bonus_paid_on') = 'string' THEN (i.v ->> 'bonus_paid_on')::date END AS bonus_paid_on,
           i.v -> 'shares' AS shares,
           i.v ? 'bonus_amount' AS has_amount,
           CASE WHEN jsonb_typeof(i.v -> 'bonus_amount') = 'number' THEN (i.v ->> 'bonus_amount')::numeric END AS bonus_amount,
           i.v ? 'formula_note' AS has_formula,
           CASE WHEN jsonb_typeof(i.v -> 'formula_note') = 'string' THEN nullif(btrim(i.v ->> 'formula_note'), '') END AS formula_note
      FROM jsonb_array_elements(p_items) AS i(v)
     ORDER BY 1
  LOOP
    SELECT d.bonus_paid_on, d.bonus_amount, d.formula_note INTO v_old
      FROM public.project_billing_bonus_dates d WHERE d.tenant_id = p_tenant_id AND d.billing_id = v_item.billing_id;
    v_amount := CASE WHEN v_item.has_amount THEN v_item.bonus_amount ELSE v_old.bonus_amount END;
    v_formula := CASE WHEN v_item.has_formula THEN v_item.formula_note ELSE v_old.formula_note END;

    IF v_amount IS NOT NULL AND
       (SELECT coalesce(sum((s.v ->> 'amount')::numeric), 0) FROM jsonb_array_elements(v_item.shares) AS s(v)) > v_amount THEN
      RAISE EXCEPTION 'set_billing_bonus_shares_batch: shares exceed bonus amount' USING ERRCODE = 'BS422';
    END IF;

    -- 已發放：任一員工在 paid、未刪批次的帶入金額淨額 ≠ 0（沖銷後淨額 0 ＝解鎖）。
    SELECT EXISTS (
      SELECT 1 FROM public.bonus_run_billing_items bi
        JOIN public.bonus_runs r ON r.id = bi.run_id AND r.status = 'paid' AND r.deleted_at IS NULL
       WHERE bi.tenant_id = p_tenant_id AND bi.billing_id = v_item.billing_id
       GROUP BY bi.employee_id
      HAVING sum(bi.amount) <> 0
    ) INTO v_locked;
    IF v_locked THEN
      IF v_item.bonus_paid_on IS DISTINCT FROM v_old.bonus_paid_on
         OR v_amount IS DISTINCT FROM v_old.bonus_amount
         OR EXISTS (
           (SELECT (s.v ->> 'employee_id')::uuid, (s.v ->> 'amount')::numeric FROM jsonb_array_elements(v_item.shares) AS s(v)
            EXCEPT
            SELECT x.employee_id, x.amount FROM public.project_billing_shares x WHERE x.tenant_id = p_tenant_id AND x.billing_id = v_item.billing_id)
           UNION ALL
           (SELECT x.employee_id, x.amount FROM public.project_billing_shares x WHERE x.tenant_id = p_tenant_id AND x.billing_id = v_item.billing_id
            EXCEPT
            SELECT (s.v ->> 'employee_id')::uuid, (s.v ->> 'amount')::numeric FROM jsonb_array_elements(v_item.shares) AS s(v))
         ) THEN
        RAISE EXCEPTION 'set_billing_bonus_shares_batch: billing bonus already paid' USING ERRCODE = 'BL409';
      END IF;
    END IF;

    DELETE FROM public.project_billing_shares WHERE tenant_id = p_tenant_id AND billing_id = v_item.billing_id;
    INSERT INTO public.project_billing_shares (tenant_id, project_id, billing_id, employee_id, amount, note, created_by, created_at, updated_at)
    SELECT p_tenant_id, p_project_id, v_item.billing_id, (s.v ->> 'employee_id')::uuid, (s.v ->> 'amount')::numeric,
           nullif(btrim(coalesce(s.v ->> 'note', '')), ''), p_actor_emp_id, v_now, v_now
      FROM jsonb_array_elements(v_item.shares) AS s(v);
    GET DIAGNOSTICS v_count = ROW_COUNT;
    v_total := v_total + v_count;

    -- 一期一列：有發獎金日、本期獎金 > 0 或算法說明任一才留（全空＝刪列；本期獎金 0 且其他都空不留列，
    -- 免得「什麼都沒有」的期別擋刪除專案）。
    IF v_item.bonus_paid_on IS NULL AND coalesce(v_amount, 0) = 0 AND v_formula IS NULL THEN
      DELETE FROM public.project_billing_bonus_dates WHERE tenant_id = p_tenant_id AND billing_id = v_item.billing_id;
    ELSE
      INSERT INTO public.project_billing_bonus_dates
        (billing_id, tenant_id, project_id, bonus_paid_on, bonus_amount, formula_note, created_by, created_at, updated_at)
      VALUES (v_item.billing_id, p_tenant_id, p_project_id, v_item.bonus_paid_on, v_amount, v_formula, p_actor_emp_id, v_now, v_now)
      ON CONFLICT (billing_id) DO UPDATE
        SET bonus_paid_on = EXCLUDED.bonus_paid_on, bonus_amount = EXCLUDED.bonus_amount,
            formula_note = EXCLUDED.formula_note, updated_at = v_now;
    END IF;

    -- 稽核摘要：不含金額、人名、日期（分潤屬集團財務，HR 看得到稽核）。
    INSERT INTO public.audit_logs (tenant_id, table_name, record_id, action, old_row, new_row, db_user, actor_emp_id, context)
    VALUES (p_tenant_id, 'project_billing_shares', v_item.billing_id, 'UPDATE', NULL,
            jsonb_build_object('project_id', p_project_id, 'billing_id', v_item.billing_id, 'people', v_count,
                               'has_bonus_paid_on', v_item.bonus_paid_on IS NOT NULL,
                               'has_bonus_amount', v_amount IS NOT NULL, 'has_formula_note', v_formula IS NOT NULL),
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

-- ── 5. 專案獎金上限比例：set_billing_bonus_cap（null＝清掉） ─────────────────────
CREATE OR REPLACE FUNCTION public.set_billing_bonus_cap(
  p_tenant_id uuid,
  p_project_id uuid,
  p_cap_pct numeric,
  p_actor_emp_id uuid
) RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_now timestamptz := now();
BEGIN
  IF p_cap_pct IS NOT NULL AND (p_cap_pct < 0 OR p_cap_pct > 100) THEN
    RAISE EXCEPTION 'set_billing_bonus_cap: cap_pct out of range' USING ERRCODE = '22023';
  END IF;
  PERFORM 1 FROM public.projects p WHERE p.id = p_project_id AND p.tenant_id = p_tenant_id AND p.deleted_at IS NULL FOR KEY SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'set_billing_bonus_cap: project not found' USING ERRCODE = 'P0002';
  END IF;
  IF p_cap_pct IS NULL THEN
    DELETE FROM public.project_billing_bonus_caps WHERE tenant_id = p_tenant_id AND project_id = p_project_id;
  ELSE
    INSERT INTO public.project_billing_bonus_caps (project_id, tenant_id, cap_pct, created_by, created_at, updated_at)
    VALUES (p_project_id, p_tenant_id, p_cap_pct, p_actor_emp_id, v_now, v_now)
    ON CONFLICT (project_id) DO UPDATE SET cap_pct = EXCLUDED.cap_pct, updated_at = v_now;
  END IF;
  INSERT INTO public.audit_logs (tenant_id, table_name, record_id, action, old_row, new_row, db_user, actor_emp_id, context)
  VALUES (p_tenant_id, 'project_billing_bonus_caps', p_project_id, 'UPDATE', NULL,
          jsonb_build_object('project_id', p_project_id, 'has_cap', p_cap_pct IS NOT NULL),
          current_user, p_actor_emp_id, 'set_billing_bonus_cap');
  RETURN p_cap_pct IS NOT NULL;
END;
$$;

REVOKE ALL ON FUNCTION public.set_billing_bonus_cap(uuid, uuid, numeric, uuid) FROM PUBLIC;
DO $$ BEGIN
  REVOKE ALL ON FUNCTION public.set_billing_bonus_cap(uuid, uuid, numeric, uuid) FROM anon, authenticated;
EXCEPTION WHEN undefined_object THEN NULL; END $$;
DO $$ BEGIN
  GRANT EXECUTE ON FUNCTION public.set_billing_bonus_cap(uuid, uuid, numeric, uuid) TO service_role;
EXCEPTION WHEN undefined_object THEN NULL; END $$;

-- ── 6. 刪除專案：bonus_run_billing_items 也擋（其餘與 0118 一字不改） ───────────────
CREATE OR REPLACE FUNCTION public.soft_delete_project(
  p_tenant_id uuid,
  p_project_id uuid,
  p_actor_emp_id uuid,
  p_reason text DEFAULT '專案刪除（打錯的空殼專案）'
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_project public.projects%ROWTYPE;
  v_now timestamptz := now();
  v_reason text := coalesce(nullif(btrim(p_reason), ''), '專案刪除（打錯的空殼專案）');
  v_blockers jsonb := '[]'::jsonb;
  v_n integer;
  v_billings integer := 0;
  v_contracts integer := 0;
  v_subs integer := 0;
  v_restored jsonb := '[]'::jsonb;
  v_unverified jsonb := '[]'::jsonb;
  v_prefix text;
  v_prev jsonb;
  v_new_reason text;
  v_new_archived_at timestamptz;
  v_new_replaced_by uuid;
  v_mode text;
  v_successor public.projects%ROWTYPE;
  v_has_successor boolean := false;
  v_matched uuid[] := ARRAY[]::uuid[];
  v_cycle boolean := false;
  v_cycle_peer uuid;
  snap record;
  v_skipped uuid[] := ARRAY[]::uuid[];
  r record;
BEGIN
  IF p_tenant_id IS NULL OR p_project_id IS NULL THEN
    RETURN jsonb_build_object('status', 'not_found');
  END IF;

  -- 鎖順序（防死鎖）：先依 id 鎖子列（期程／合約／副委託；FOR NO KEY UPDATE——不與外鍵檢查的 FOR KEY SHARE 互斥，
  -- 其他表新增時對這些列的外鍵檢查不會被卡住），再鎖專案列——與「UPDATE 子列先鎖列、觸發器再對專案取 FOR KEY SHARE」
  -- 的寫入同序。專案列鎖住之後，子表的新寫入（觸發器）都要等本交易結束。
  PERFORM 1 FROM public.project_billings b WHERE b.tenant_id = p_tenant_id AND b.project_id = p_project_id ORDER BY b.id FOR NO KEY UPDATE;
  PERFORM 1 FROM public.contracts c WHERE c.tenant_id = p_tenant_id AND c.project_id = p_project_id ORDER BY c.id FOR NO KEY UPDATE;
  PERFORM 1 FROM public.project_subcontracts s WHERE s.tenant_id = p_tenant_id AND s.project_id = p_project_id ORDER BY s.id FOR NO KEY UPDATE;
  -- 換案鏈上相關的專案（本案、本案的後繼案、被本案取代的原案；含只在稽核裡的關係）依 id 一次鎖住：
  -- 同時刪除鏈上兩案（例：N1 與 N2）時兩邊以同一順序取鎖，不會互等成死鎖。
  -- 0100：分叉鏈（O 先被 N1 取代、又複製成 N1'）時，還原快照會對「原案稽核快照裡的 replaced_by_project_id」取鎖；
  -- 那些案也放進同一個依 id 排序的集合，避免與同時刪除 N1 的交易交錯成死鎖。
  PERFORM 1 FROM public.projects q
   WHERE q.tenant_id = p_tenant_id
     AND q.id IN (
      WITH origins AS (
        SELECT o.id FROM public.projects o WHERE o.tenant_id = p_tenant_id AND o.replaced_by_project_id = p_project_id
        UNION SELECT l.record_id FROM public.audit_logs l
               WHERE l.tenant_id = p_tenant_id AND l.table_name = 'projects'
                 AND l.context = 'POST /projects/:id/duplicate (archive original)' AND l.new_row ->> 'replaced_by' = p_project_id::text
        UNION SELECT (l.new_row ->> 'duplicated_from')::uuid FROM public.audit_logs l
               WHERE l.tenant_id = p_tenant_id AND l.table_name = 'projects' AND l.record_id = p_project_id
                 AND l.action = 'INSERT' AND l.context = 'POST /projects/:id/duplicate' AND l.new_row ? 'duplicated_from'
      ), related AS (
        SELECT p_project_id AS id
        UNION SELECT pp.replaced_by_project_id FROM public.projects pp WHERE pp.id = p_project_id AND pp.replaced_by_project_id IS NOT NULL
        UNION SELECT (l.new_row ->> 'replaced_by')::uuid FROM public.audit_logs l
               WHERE l.tenant_id = p_tenant_id AND l.table_name = 'projects' AND l.record_id = p_project_id
                 AND l.context = 'POST /projects/:id/duplicate (archive original)' AND l.new_row ? 'replaced_by'
        UNION SELECT id FROM origins
        UNION SELECT (a.old_row ->> 'replaced_by_project_id')::uuid FROM public.audit_logs a
               WHERE a.tenant_id = p_tenant_id AND a.table_name = 'projects' AND a.action = 'UPDATE'
                 AND a.record_id IN (SELECT id FROM origins)
                 AND nullif(a.old_row ->> 'replaced_by_project_id', '') IS NOT NULL
      )
      SELECT id FROM related)
   ORDER BY q.id
   FOR UPDATE;
  SELECT * INTO v_project FROM public.projects
   WHERE tenant_id = p_tenant_id AND id = p_project_id AND deleted_at IS NULL
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('status', 'not_found');
  END IF;

  -- ── 擋刪條件（順序與 project-delete.ts planProjectDelete 一致） ──
  SELECT count(*) INTO v_n FROM public.project_billings b
   WHERE b.tenant_id = p_tenant_id AND b.project_id = p_project_id AND b.deleted_at IS NULL
     AND (b.billed_on IS NOT NULL OR b.billed_amount IS NOT NULL OR nullif(b.invoice_no, '') IS NOT NULL
          OR b.invoiced_on IS NOT NULL OR b.received_on IS NOT NULL OR b.received_amount IS NOT NULL);
  IF v_n > 0 THEN v_blockers := v_blockers || jsonb_build_object('key', 'billing_activity', 'count', v_n); END IF;

  SELECT count(*) INTO v_n FROM public.project_billing_shares s WHERE s.tenant_id = p_tenant_id AND s.project_id = p_project_id;
  IF v_n > 0 THEN v_blockers := v_blockers || jsonb_build_object('key', 'billing_shares', 'count', v_n); END IF;

  SELECT count(*) INTO v_n FROM public.project_billing_bonus_dates d WHERE d.tenant_id = p_tenant_id AND d.project_id = p_project_id;
  IF v_n > 0 THEN v_blockers := v_blockers || jsonb_build_object('key', 'billing_bonus_dates', 'count', v_n); END IF;

  SELECT count(*) INTO v_n FROM public.bonus_run_items i WHERE i.tenant_id = p_tenant_id AND i.project_id = p_project_id;
  IF v_n > 0 THEN v_blockers := v_blockers || jsonb_build_object('key', 'bonus_run_items', 'count', v_n); END IF;

  -- 0119：季獎金批次帶入的每期分潤（bonus_run_billing_items，任何狀態的批次）也擋，同 bonus_run_items。
  SELECT count(*) INTO v_n FROM public.bonus_run_billing_items i WHERE i.tenant_id = p_tenant_id AND i.project_id = p_project_id;
  IF v_n > 0 THEN v_blockers := v_blockers || jsonb_build_object('key', 'bonus_run_billing_items', 'count', v_n); END IF;

  -- 0118（2026-11-18 業主決定）：分潤比例異動紀錄（project_share_adjustments）本身不再擋刪——只改過趴數、
  -- 從沒算過／發過獎金的案可以刪；異動紀錄原樣保留（稽核），不刪不改。實際算過／發過的獎金與分潤仍由上面
  -- project_billing_shares（每期款獎金分潤）、project_billing_bonus_dates（發獎金日）、bonus_run_items
  -- （獎金計算批次，含草稿）擋下。

  SELECT count(*) INTO v_n FROM public.attendance_sheet_days d WHERE d.tenant_id = p_tenant_id AND d.project_id = p_project_id;
  IF v_n > 0 THEN v_blockers := v_blockers || jsonb_build_object('key', 'attendance_days', 'count', v_n); END IF;

  -- 已作廢（void）放款單的分攤不算（作廢單不能刪、分攤也留著；不排除的話專案永遠刪不掉）。草稿仍算（可改分攤）。
  SELECT count(DISTINCT x.id) INTO v_n FROM public.disbursement_allocations x
    JOIN public.disbursements dd ON dd.id = x.disbursement_id AND dd.status <> 'void'
   WHERE x.tenant_id = p_tenant_id
     AND (x.project_id = p_project_id
          OR x.subcontract_id IN (SELECT s.id FROM public.project_subcontracts s
                                   WHERE s.tenant_id = p_tenant_id AND s.project_id = p_project_id));
  IF v_n > 0 THEN v_blockers := v_blockers || jsonb_build_object('key', 'disbursements', 'count', v_n); END IF;

  SELECT count(*) INTO v_n FROM public.project_documents d WHERE d.tenant_id = p_tenant_id AND d.project_id = p_project_id;
  IF v_n > 0 THEN v_blockers := v_blockers || jsonb_build_object('key', 'documents', 'count', v_n); END IF;

  SELECT count(*) INTO v_n FROM public.contracts c
   WHERE c.tenant_id = p_tenant_id AND c.project_id = p_project_id AND c.deleted_at IS NULL
     AND (c.signed_on IS NOT NULL OR c.stamp_duty_paid_on IS NOT NULL);
  IF v_n > 0 THEN v_blockers := v_blockers || jsonb_build_object('key', 'signed_contracts', 'count', v_n); END IF;

  SELECT count(*) INTO v_n FROM public.project_subcontracts s
   WHERE s.tenant_id = p_tenant_id AND s.project_id = p_project_id AND s.deleted_at IS NULL
     AND (nullif(s.invoice_no, '') IS NOT NULL OR s.invoice_date IS NOT NULL);
  IF v_n > 0 THEN v_blockers := v_blockers || jsonb_build_object('key', 'invoiced_subcontracts', 'count', v_n); END IF;

  -- 副委託期款已付款／已驗收（含已刪除的副委託底下的期款：錢已經付出去，一律擋）。
  SELECT count(*) INTO v_n FROM public.project_subcontract_payments sp
   WHERE sp.tenant_id = p_tenant_id
     AND sp.subcontract_id IN (SELECT s.id FROM public.project_subcontracts s
                                WHERE s.tenant_id = p_tenant_id AND s.project_id = p_project_id)
     AND (sp.paid_on IS NOT NULL OR sp.paid_amount IS NOT NULL OR sp.accepted_on IS NOT NULL);
  IF v_n > 0 THEN v_blockers := v_blockers || jsonb_build_object('key', 'paid_subcontract_payments', 'count', v_n); END IF;

  SELECT count(*) INTO v_n FROM public.project_subcontracts s
   WHERE s.tenant_id = p_tenant_id AND s.project_id = p_project_id AND s.deleted_at IS NULL
     AND s.kind = 'firm' AND s.withholding_date IS NOT NULL;
  IF v_n > 0 THEN v_blockers := v_blockers || jsonb_build_object('key', 'withheld_subcontracts', 'count', v_n); END IF;

  SELECT count(*) INTO v_n FROM public.projects c
   WHERE c.tenant_id = p_tenant_id AND c.parent_project_id = p_project_id AND c.deleted_at IS NULL;
  IF v_n > 0 THEN v_blockers := v_blockers || jsonb_build_object('key', 'child_projects', 'count', v_n); END IF;

  IF jsonb_array_length(v_blockers) > 0 THEN
    RETURN jsonb_build_object('status', 'blocked', 'blockers', v_blockers);
  END IF;

  -- ── 連帶軟刪除（專案還沒標刪除，子表觸發器放行；條件再帶一次「沒有金流」當第二道防線） ──
  UPDATE public.project_billings b
     SET deleted_at = v_now, deleted_by_emp_id = p_actor_emp_id, delete_reason = v_reason
   WHERE b.tenant_id = p_tenant_id AND b.project_id = p_project_id AND b.deleted_at IS NULL
     AND b.billed_on IS NULL AND b.billed_amount IS NULL AND nullif(b.invoice_no, '') IS NULL
     AND b.invoiced_on IS NULL AND b.received_on IS NULL AND b.received_amount IS NULL;
  GET DIAGNOSTICS v_billings = ROW_COUNT;

  UPDATE public.contracts c
     SET deleted_at = v_now, deleted_by_emp_id = p_actor_emp_id, delete_reason = v_reason
   WHERE c.tenant_id = p_tenant_id AND c.project_id = p_project_id AND c.deleted_at IS NULL
     AND c.signed_on IS NULL AND c.stamp_duty_paid_on IS NULL;
  GET DIAGNOSTICS v_contracts = ROW_COUNT;

  UPDATE public.project_subcontracts s
     SET deleted_at = v_now, deleted_by = p_actor_emp_id, delete_reason = v_reason, updated_at = v_now
   WHERE s.tenant_id = p_tenant_id AND s.project_id = p_project_id AND s.deleted_at IS NULL
     AND nullif(s.invoice_no, '') IS NULL AND s.invoice_date IS NULL
     AND NOT (s.kind = 'firm' AND s.withholding_date IS NOT NULL)
     AND NOT EXISTS (SELECT 1 FROM public.project_subcontract_payments sp
                      WHERE sp.subcontract_id = s.id
                        AND (sp.paid_on IS NOT NULL OR sp.paid_amount IS NOT NULL OR sp.accepted_on IS NOT NULL))
     AND NOT EXISTS (SELECT 1 FROM public.disbursement_allocations x
                      JOIN public.disbursements dd ON dd.id = x.disbursement_id AND dd.status <> 'void'
                     WHERE x.subcontract_id = s.id);
  GET DIAGNOSTICS v_subs = ROW_COUNT;

  -- ── 本案自己是否已被別案（X）取代：換案複製鏈 O→本案→X，原案改指向 X，不還原 ──
  IF v_project.archive_reason ~ '^已由 .+ 取代：' THEN
    SELECT x.* INTO v_successor FROM public.projects x
     WHERE x.tenant_id = p_tenant_id AND x.deleted_at IS NULL AND x.id <> p_project_id
       AND (x.id = v_project.replaced_by_project_id
            OR (v_project.replaced_by_project_id IS NULL AND x.id = (
                 SELECT (l.new_row ->> 'replaced_by')::uuid FROM public.audit_logs l
                  WHERE l.tenant_id = p_tenant_id AND l.table_name = 'projects' AND l.record_id = p_project_id
                    AND l.context = 'POST /projects/:id/duplicate (archive original)'
                    AND l.new_row ->> 'archive_reason' = v_project.archive_reason
                  ORDER BY l.at DESC LIMIT 1)))
     LIMIT 1
     FOR SHARE OF x;
    v_has_successor := FOUND;
    -- 後繼案自己指回本案（環）：不當作後繼案。
    IF v_has_successor AND v_successor.replaced_by_project_id = p_project_id THEN
      v_has_successor := false;
      v_cycle := true;
      v_cycle_peer := v_successor.id;
    END IF;
  END IF;

  -- ── 被本案取代而封存的原案（只用 id 比對） ──
  v_prefix := CASE WHEN v_project.code IS NULL THEN NULL ELSE '已由 ' || v_project.code || ' 取代：' END;
  FOR r IN
    SELECT p.id, p.code, p.archived_at, p.archive_reason
      FROM public.projects p
     WHERE p.tenant_id = p_tenant_id AND p.id <> p_project_id AND p.deleted_at IS NULL
       AND p.archive_reason ~ '^已由 .+ 取代：'
       AND (p.replaced_by_project_id = p_project_id
            OR (p.replaced_by_project_id IS NULL AND (
                 EXISTS (SELECT 1 FROM public.audit_logs l
                          WHERE l.tenant_id = p_tenant_id AND l.table_name = 'projects' AND l.record_id = p.id
                            AND l.context = 'POST /projects/:id/duplicate (archive original)'
                            AND l.new_row ->> 'replaced_by' = p_project_id::text
                            AND l.new_row ->> 'archive_reason' = p.archive_reason)
                 OR (v_prefix IS NOT NULL AND starts_with(p.archive_reason, v_prefix)
                     AND EXISTS (SELECT 1 FROM public.audit_logs l
                                  WHERE l.tenant_id = p_tenant_id AND l.table_name = 'projects' AND l.record_id = p_project_id
                                    AND l.action = 'INSERT' AND l.context = 'POST /projects/:id/duplicate'
                                    AND l.new_row ->> 'duplicated_from' = p.id::text
                                    AND l.new_row ->> 'archive_original' = 'true')))))
     ORDER BY p.id
     FOR UPDATE OF p
  LOOP
    -- 環（原案就是本案的後繼案、或本案的後繼案指回本案）：不動，列 unverified 請手動檢查。
    -- 環的另一端以實際找到的後繼 id 比對（後繼案可能是從稽核找到的，本案 replaced_by_project_id 為 NULL）。
    IF (v_has_successor AND r.id = v_successor.id) OR (v_cycle AND r.id = v_cycle_peer) THEN
      v_skipped := v_skipped || r.id;
      CONTINUE;
    END IF;
    v_matched := v_matched || r.id;
    IF v_has_successor THEN
      -- 鏈：原案改由 X 取代（封存保留、仍排除獎金）。
      UPDATE public.projects
         SET archive_reason = '已由 ' || coalesce(v_successor.code, v_successor.name) || ' 取代：'
                              || regexp_replace(r.archive_reason, '^已由 .+? 取代：', ''),
             replaced_by_project_id = v_successor.id
       WHERE id = r.id;
      v_restored := v_restored || jsonb_build_object(
        'id', r.id, 'code', r.code, 'mode', 'repointed', 'archived', r.archived_at IS NOT NULL,
        'toId', v_successor.id, 'toCode', v_successor.code);
      CONTINUE;
    END IF;
    -- audit_all（AFTER UPDATE）留下的整列快照：寫入這個取代原因的那一次更新，取它的舊值。
    -- 只採用「還原後狀態合法」的快照（換案鏈 O→N1→N2 先刪 N1 再刪 N2 時，最新快照的舊值是「已由 N1 取代」）：
    --   • 舊原因不是取代原因 → 可以還原（replaced_by 清空）；
    --   • 舊原因是取代原因 → 只有快照裡的 replaced_by_project_id 指向「未刪除、不是本案、不是原案自己」的案才可以，
    --     並同步把 replaced_by 指回那一案；否則跳過這筆快照往前找。
    v_prev := NULL;
    FOR snap IN
      SELECT a.old_row FROM public.audit_logs a
       WHERE a.tenant_id = p_tenant_id AND a.table_name = 'projects' AND a.record_id = r.id AND a.action = 'UPDATE'
         AND a.old_row ? 'archive_reason' AND a.old_row ? 'archived_at'
         AND a.new_row ->> 'archive_reason' = r.archive_reason
         AND (a.old_row ->> 'archive_reason') IS DISTINCT FROM r.archive_reason
       ORDER BY a.at DESC
    LOOP
      IF NOT coalesce(snap.old_row ->> 'archive_reason', '') ~ '^已由 .+ 取代：' THEN
        v_prev := snap.old_row;
        EXIT;
      END IF;
      -- 舊值是取代原因：先把它指向的案 FOR SHARE 鎖住（且未刪除、非本案、非原案自己）才採用，否則往前找。
      PERFORM 1 FROM public.projects z
       WHERE z.tenant_id = p_tenant_id AND z.deleted_at IS NULL
         AND z.id::text = snap.old_row ->> 'replaced_by_project_id'
         AND z.id <> p_project_id AND z.id <> r.id
       FOR SHARE;
      IF FOUND THEN
        v_prev := snap.old_row;
        EXIT;
      END IF;
    END LOOP;
    IF v_prev IS NOT NULL THEN
      v_mode := 'restored';
      v_new_reason := v_prev ->> 'archive_reason';
      v_new_archived_at := CASE WHEN r.archived_at IS NULL THEN NULL ELSE (v_prev ->> 'archived_at')::timestamptz END;
      v_new_replaced_by := CASE WHEN coalesce(v_new_reason, '') ~ '^已由 .+ 取代：'
                                THEN (v_prev ->> 'replaced_by_project_id')::uuid ELSE NULL END;
    ELSE
      -- 找不到合法快照：解除取代標記、保留封存，回 unmarked（畫面提示手動確認）。
      v_mode := 'unmarked';
      v_new_reason := '原取代案 ' || coalesce(v_project.code, v_project.name) || ' 已刪除，已解除取代標記（封存保留，需要時請自行解除封存）';
      v_new_archived_at := r.archived_at;
      v_new_replaced_by := NULL;
    END IF;
    UPDATE public.projects
       SET archive_reason = v_new_reason, archived_at = v_new_archived_at, replaced_by_project_id = v_new_replaced_by
     WHERE id = r.id;
    v_restored := v_restored || jsonb_build_object(
      'id', r.id, 'code', r.code, 'mode', v_mode, 'archived', v_new_archived_at IS NOT NULL);
  END LOOP;

  -- 只有序號前綴吻合、id 對不上（可能是改號後被重用、或手填相同字樣、或當時稽核沒寫成），以及因取代關係成環而跳過的案
  -- → 不動，請使用者手動檢查。
  SELECT coalesce(jsonb_agg(jsonb_build_object('id', p.id, 'code', p.code) ORDER BY p.id), '[]'::jsonb) INTO v_unverified
    FROM public.projects p
   WHERE p.tenant_id = p_tenant_id AND p.id <> p_project_id AND p.deleted_at IS NULL
     AND ((v_prefix IS NOT NULL AND starts_with(p.archive_reason, v_prefix)) OR p.id = ANY (v_skipped))
     AND NOT (p.id = ANY (v_matched));

  UPDATE public.projects SET deleted_at = v_now, deleted_by_emp_id = p_actor_emp_id WHERE id = p_project_id;

  RETURN jsonb_build_object(
    'status', 'deleted',
    'id', v_project.id,
    'code', v_project.code,
    'cascade', jsonb_build_object('billings', v_billings, 'contracts', v_contracts, 'subcontracts', v_subs),
    'restored', v_restored,
    'unverified', v_unverified
  );
END;
$$;

REVOKE ALL ON FUNCTION public.soft_delete_project(uuid, uuid, uuid, text) FROM PUBLIC;
DO $$ BEGIN
  REVOKE ALL ON FUNCTION public.soft_delete_project(uuid, uuid, uuid, text) FROM anon, authenticated;
EXCEPTION WHEN undefined_object THEN NULL; END $$;
DO $$ BEGIN
  GRANT EXECUTE ON FUNCTION public.soft_delete_project(uuid, uuid, uuid, text) TO service_role;
EXCEPTION WHEN undefined_object THEN NULL; END $$;

NOTIFY pgrst, 'reload schema';
-- 2026-11-19 季獎金批次發放時的每期款獎金防線（本檔 ＝ sql/0110 ＝ migration 0120；接 0119 ＝ sql/0109）。
--
-- 0119 之後 API payRun 是「先查別批有沒有發過 → 再把批次改 paid」，兩批同時發放可能都查到「沒發過」而重複發同一期；
-- 核准後到發放那一刻之間若有人改了每期分潤，批次會以舊金額發出、該期隨即鎖定，差額永遠帶不進來。
-- 這支 BEFORE UPDATE 觸發器在 bonus_runs 由非 paid 變 paid（一般批次）時、同一交易內：
--   1. 依期別 id 排序取 advisory lock（鍵同 set_billing_bonus_shares_batch：'billing_shares:'||billing_id）——
--      與同一期的分潤寫入、另一批的發放互相排隊；
--   2. 本批帶入的任一（期別、員工）在其他 paid、未刪批次的淨額 ≠ 0 → RAISE BL409（已在別批發放）；
--   3. 本批凍結的金額／發獎金日與目前的每期分潤不一致（核准後被改過）→ RAISE BL409（請重算）。
-- 觸發器函式是 VOLATILE（每個查詢重取快照）：拿到鎖之後看得到剛提交的另一批發放。
-- 沖銷批次（kind='reversal'）不檢查（負數列本來就是對已發的抵銷）。
-- 前提：已套 0119（sql/0109）。只有 DDL（函式＋觸發器），不動任何資料列；可重跑。
CREATE OR REPLACE FUNCTION public.bonus_runs_billing_pay_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_bad integer;
BEGIN
  IF NEW.kind = 'reversal' THEN
    RETURN NEW;
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext('billing_shares:' || x.billing_id::text))
     FROM (SELECT DISTINCT i.billing_id FROM public.bonus_run_billing_items i WHERE i.run_id = NEW.id ORDER BY 1) AS x;

  SELECT count(*) INTO v_bad
    FROM public.bonus_run_billing_items i
   WHERE i.run_id = NEW.id
     AND EXISTS (
       SELECT 1
         FROM public.bonus_run_billing_items o
         JOIN public.bonus_runs r ON r.id = o.run_id AND r.status = 'paid' AND r.deleted_at IS NULL
        WHERE o.tenant_id = i.tenant_id AND o.billing_id = i.billing_id AND o.employee_id = i.employee_id AND o.run_id <> NEW.id
       HAVING sum(o.amount) <> 0
     );
  IF v_bad > 0 THEN
    RAISE EXCEPTION 'bonus_runs: billing bonus already paid in another run' USING ERRCODE = 'BL409';
  END IF;

  SELECT count(*) INTO v_bad
    FROM public.bonus_run_billing_items i
   WHERE i.run_id = NEW.id
     AND (
       i.amount IS DISTINCT FROM (SELECT s.amount FROM public.project_billing_shares s
                                   WHERE s.tenant_id = i.tenant_id AND s.billing_id = i.billing_id AND s.employee_id = i.employee_id)
       OR i.bonus_paid_on IS DISTINCT FROM (SELECT d.bonus_paid_on FROM public.project_billing_bonus_dates d
                                             WHERE d.tenant_id = i.tenant_id AND d.billing_id = i.billing_id)
     );
  IF v_bad > 0 THEN
    RAISE EXCEPTION 'bonus_runs: billing bonus changed since approval' USING ERRCODE = 'BL409';
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.bonus_runs_billing_pay_guard() FROM PUBLIC;
DO $$ BEGIN
  REVOKE ALL ON FUNCTION public.bonus_runs_billing_pay_guard() FROM anon, authenticated;
EXCEPTION WHEN undefined_object THEN NULL; END $$;

DROP TRIGGER IF EXISTS bonus_runs_billing_pay_guard ON public.bonus_runs;
CREATE TRIGGER bonus_runs_billing_pay_guard
  BEFORE UPDATE OF status ON public.bonus_runs
  FOR EACH ROW
  WHEN (NEW.status = 'paid' AND OLD.status IS DISTINCT FROM 'paid')
  EXECUTE FUNCTION public.bonus_runs_billing_pay_guard();
-- 2026-11-19 每期款獎金帶入列的寫入防線（本檔 ＝ sql/0111 ＝ migration 0121；接 0120 ＝ sql/0110）。
--
-- 驗收追加：
--   1. bonus_run_billing_items 加 BEFORE INSERT OR UPDATE 觸發器：以 NEW.run_id 查母批次，status='paid' 即擋
--      （ERRCODE restrict_violation／23001，同 forbid_paid_bonus_mutation；test／demo 租戶 is_disposable_tenant 放行）。
--      0119 掛的 forbid_paid_bonus_mutation 只看 OLD（UPDATE／DELETE 已發的列）；這支補上「新增到已發批次」與
--      「UPDATE 把 run_id 改指向已發批次」。
--   2. replace_bonus_run_billing_items()：整批換掉某批次的帶入列改走 DB 函式——同一交易內先刪後插（全成全敗），
--      鎖順序同發放（bonus_runs_billing_pay_guard：先鎖批次列、再依期別 id 排序取 'billing_shares:'||billing_id
--      advisory lock，含舊列與新列的期別），與同一期的分潤寫入、另一批的發放互相排隊。批次不存在／已刪／不屬此租戶
--      → P0002；已發 → 23001。只給 service_role、security definer、search_path 固定。
-- 前提：已套 0120（sql/0110）。只有 DDL，不動任何資料列；可重跑。

CREATE OR REPLACE FUNCTION public.bonus_run_billing_items_paid_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_status text;
  v_tenant uuid;
BEGIN
  SELECT r.status, r.tenant_id INTO v_status, v_tenant FROM public.bonus_runs r WHERE r.id = NEW.run_id;
  IF v_status IS DISTINCT FROM 'paid' THEN
    RETURN NEW;
  END IF;
  IF public.is_disposable_tenant(v_tenant) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION
    'bonus_run_billing_items 所屬批次已發放（paid），不可 %——發放批次是凍結快照（見 migration 0121）。', TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$;

REVOKE ALL ON FUNCTION public.bonus_run_billing_items_paid_guard() FROM PUBLIC;
DO $$ BEGIN
  REVOKE ALL ON FUNCTION public.bonus_run_billing_items_paid_guard() FROM anon, authenticated;
EXCEPTION WHEN undefined_object THEN NULL; END $$;

DROP TRIGGER IF EXISTS bonus_run_billing_items_paid_guard ON public.bonus_run_billing_items;
CREATE TRIGGER bonus_run_billing_items_paid_guard
  BEFORE INSERT OR UPDATE ON public.bonus_run_billing_items
  FOR EACH ROW EXECUTE FUNCTION public.bonus_run_billing_items_paid_guard();

-- p_items：[{"billing_id","project_id","employee_id","amount": number,"bonus_paid_on": "YYYY-MM-DD"|null,"snapshot": object|null}, …]
-- （空陣列＝清掉該批全部帶入列）。回傳寫入列數。
CREATE OR REPLACE FUNCTION public.replace_bonus_run_billing_items(
  p_tenant_id uuid,
  p_run_id uuid,
  p_items jsonb
) RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_status text;
  v_count integer;
BEGIN
  IF p_items IS NULL OR jsonb_typeof(p_items) <> 'array' THEN
    RAISE EXCEPTION 'replace_bonus_run_billing_items: items must be an array' USING ERRCODE = '22023';
  END IF;
  -- 鎖順序同發放：先鎖批次列，再取期別 advisory lock。
  SELECT r.status INTO v_status
    FROM public.bonus_runs r
   WHERE r.id = p_run_id AND r.tenant_id = p_tenant_id AND r.deleted_at IS NULL
     FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'replace_bonus_run_billing_items: run not found' USING ERRCODE = 'P0002';
  END IF;
  IF v_status = 'paid' AND NOT public.is_disposable_tenant(p_tenant_id) THEN
    RAISE EXCEPTION 'replace_bonus_run_billing_items: run already paid' USING ERRCODE = 'restrict_violation';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext('billing_shares:' || x.id::text))
     FROM (
       SELECT b.billing_id AS id FROM public.bonus_run_billing_items b WHERE b.run_id = p_run_id
       UNION
       SELECT (i.v ->> 'billing_id')::uuid FROM jsonb_array_elements(p_items) AS i(v)
       ORDER BY 1
     ) AS x;

  DELETE FROM public.bonus_run_billing_items WHERE tenant_id = p_tenant_id AND run_id = p_run_id;
  INSERT INTO public.bonus_run_billing_items (tenant_id, run_id, project_id, billing_id, employee_id, amount, bonus_paid_on, snapshot)
  SELECT p_tenant_id, p_run_id, (i.v ->> 'project_id')::uuid, (i.v ->> 'billing_id')::uuid, (i.v ->> 'employee_id')::uuid,
         (i.v ->> 'amount')::numeric,
         CASE WHEN jsonb_typeof(i.v -> 'bonus_paid_on') = 'string' THEN (i.v ->> 'bonus_paid_on')::date END,
         CASE WHEN jsonb_typeof(i.v -> 'snapshot') = 'object' THEN i.v -> 'snapshot' END
    FROM jsonb_array_elements(p_items) AS i(v);
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

REVOKE ALL ON FUNCTION public.replace_bonus_run_billing_items(uuid, uuid, jsonb) FROM PUBLIC;
DO $$ BEGIN
  REVOKE ALL ON FUNCTION public.replace_bonus_run_billing_items(uuid, uuid, jsonb) FROM anon, authenticated;
EXCEPTION WHEN undefined_object THEN NULL; END $$;
DO $$ BEGIN
  GRANT EXECUTE ON FUNCTION public.replace_bonus_run_billing_items(uuid, uuid, jsonb) TO service_role;
EXCEPTION WHEN undefined_object THEN NULL; END $$;

NOTIFY pgrst, 'reload schema';
