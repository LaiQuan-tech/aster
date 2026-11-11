-- 2026-11-10 專案申請單版本（migration 0090 ＝ sql/0080）。合約金額（未稅）改了 → 申請單變下一版；舊版唯讀可調閱、可列印。
-- 前提：已套 0089（sql/0079，docs/套用-2026-11-10-副委託事務所與發票.sql）。純新增、冪等、包在交易內；不動任何既有表或資料。
-- 套用前就部署的 API 會降級：版本列表回 available=false（前端隱藏版本 UI）、改合約金額照存不建版、手動另存回 409 migration_required。
-- 此表不掛 audit_all（快照含利潤／毛利率）；建版稽核由 record_application_version() 寫不含快照的摘要。
-- 套用後跑 docs/驗證-2026-11-10-申請單版本.sql。
-- 已用 `npm run db:replay -- --base-migration 53 --base-sql 62 --base-file docs/套用-2026-11-08-薪資津貼勞退.sql
--   --base-file docs/套用-2026-11-08-加班基數.sql --base-file docs/套用-2026-11-10-薪資投保歷程.sql
--   --base-file docs/套用-2026-11-10-副委託事務所與發票.sql
--   docs/套用-2026-11-10-申請單版本.sql --verify docs/驗證-2026-11-10-申請單版本.sql` 在 pglite 上套兩遍（驗冪等）＋驗證全部通過。
BEGIN;

-- 2026-11-10 專案申請單「版本」：合約金額（銷售金額未稅）改了 → 申請單變下一版；舊版可調出來看（唯讀、可列印）。
--   project_application_versions：每個專案的申請單版本（version_no 專案內 1、2、3…遞增，unique(project_id, version_no)）。
--     snapshot jsonb ＝申請單當時的完整內容（與 GET /projects/:id/application 的 application 段同形狀：專案欄位、
--     客戶、設計內容、訂單、銷售金額未稅／營業稅／總額、付款方式、付款階段各列、審迄還款、發包各列、其他支出、利潤、毛利率…）。
--     trigger：initial（第一次改合約金額時，把改之前的內容存成第 1 版）／contract_amount_changed（改後的內容）／manual（手動另存）。
--     amount_before／amount_after：合約金額（未稅）改前／改後（manual／initial 只記當時金額於 amount_after）。
--     superseded_at：被下一版取代的時間；取代當下把這一版的 snapshot 更新成「被取代前的最後內容」
--       （版本在成為舊版之前＝即時資料，其他欄位修改不建新版），之後不再變動。NULL＝目前版。
--   record_application_version()：建版的唯一入口（API 以 service role 呼叫）。advisory lock（每專案）＋同一交易內：
--     判斷有無版本 → 凍結目前版 → 取號 → 寫新版 → 寫不含快照的稽核摘要。失敗整體回滾。
--   稽核：快照含利潤／毛利率（集團財務），**不掛 audit_all**（否則整份快照進 audit_logs，沒有利潤權限的 HR 從稽核看得到）；
--     改由函式寫一筆摘要（project_id、version_no、trigger、amount_before／after、操作者），不含 snapshot。
-- 前提：已套到 0089（sql/0079）。純新增、可重跑（IF NOT EXISTS／duplicate_object／CREATE OR REPLACE）；不動任何既有表或資料。
-- 只由 API（service role）存取：RLS 開、不給 policy；函式 revoke PUBLIC／anon／authenticated，只給 service_role。版本不提供刪除。
CREATE TABLE IF NOT EXISTS public.project_application_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenants(id),
  project_id uuid NOT NULL REFERENCES public.projects(id),
  version_no integer NOT NULL,
  snapshot jsonb NOT NULL,
  trigger text NOT NULL,
  amount_before numeric,
  amount_after numeric,
  note text,
  created_by_emp_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  superseded_at timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS project_application_versions_project_no_uq
  ON public.project_application_versions (project_id, version_no);
CREATE INDEX IF NOT EXISTS project_application_versions_tenant_project_idx
  ON public.project_application_versions (tenant_id, project_id);
DO $$ BEGIN
  ALTER TABLE public.project_application_versions ADD CONSTRAINT project_application_versions_trigger_chk
    CHECK (trigger IN ('initial', 'contract_amount_changed', 'manual'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE public.project_application_versions ADD CONSTRAINT project_application_versions_no_chk CHECK (version_no >= 1);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE public.project_application_versions ADD CONSTRAINT project_application_versions_note_chk
    CHECK (note IS NULL OR char_length(note) <= 500);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE public.project_application_versions ENABLE ROW LEVEL SECURITY;
-- 不掛 audit_all（見檔頭「稽核」）；DROP 讓先前若掛過的環境也一致。
DROP TRIGGER IF EXISTS audit_all ON public.project_application_versions;

CREATE OR REPLACE FUNCTION public.record_application_version(
  p_tenant_id uuid,
  p_project_id uuid,
  p_trigger text,
  p_before_snapshot jsonb,
  p_after_snapshot jsonb,
  p_amount_before numeric,
  p_amount_after numeric,
  p_note text,
  p_actor_emp_id uuid
) RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_latest record;
  v_no integer;
  v_id uuid;
  v_now timestamptz := now();
BEGIN
  IF p_trigger NOT IN ('contract_amount_changed', 'manual') THEN
    RAISE EXCEPTION 'record_application_version: invalid trigger %', p_trigger USING ERRCODE = '22023';
  END IF;
  IF p_after_snapshot IS NULL OR p_before_snapshot IS NULL THEN
    RAISE EXCEPTION 'record_application_version: snapshot required' USING ERRCODE = '22023';
  END IF;
  -- 同一專案的建版排隊（交易結束自動釋放）：避免兩個請求取到同一版號、或凍結到錯的一版。
  PERFORM pg_advisory_xact_lock(hashtext(p_project_id::text));
  IF NOT EXISTS (SELECT 1 FROM public.projects WHERE id = p_project_id AND tenant_id = p_tenant_id) THEN
    RAISE EXCEPTION 'record_application_version: project not found' USING ERRCODE = 'P0002';
  END IF;

  SELECT id, version_no INTO v_latest
    FROM public.project_application_versions
   WHERE tenant_id = p_tenant_id AND project_id = p_project_id
   ORDER BY version_no DESC LIMIT 1;

  IF v_latest.id IS NULL THEN
    IF p_trigger = 'contract_amount_changed' THEN
      -- 第一次改合約金額：改之前的內容存成第 1 版（一建好就被第 2 版取代）。
      INSERT INTO public.project_application_versions
        (tenant_id, project_id, version_no, snapshot, trigger, amount_before, amount_after, created_by_emp_id, created_at, superseded_at)
      VALUES (p_tenant_id, p_project_id, 1, p_before_snapshot, 'initial', NULL, p_amount_before, p_actor_emp_id, v_now, v_now)
      RETURNING id INTO v_id;
      INSERT INTO public.audit_logs (tenant_id, table_name, record_id, action, old_row, new_row, db_user, actor_emp_id, context)
      VALUES (p_tenant_id, 'project_application_versions', v_id, 'INSERT', NULL,
              jsonb_build_object('project_id', p_project_id, 'version_no', 1, 'trigger', 'initial', 'amount_before', NULL, 'amount_after', p_amount_before),
              current_user, p_actor_emp_id, 'record_application_version');
      v_no := 2;
    ELSE
      v_no := 1;
    END IF;
  ELSE
    -- 目前版被取代：快照凍結成被取代前的最後內容。
    UPDATE public.project_application_versions
       SET snapshot = p_before_snapshot, superseded_at = v_now
     WHERE id = v_latest.id;
    INSERT INTO public.audit_logs (tenant_id, table_name, record_id, action, old_row, new_row, db_user, actor_emp_id, context)
    VALUES (p_tenant_id, 'project_application_versions', v_latest.id, 'UPDATE', NULL,
            jsonb_build_object('project_id', p_project_id, 'version_no', v_latest.version_no, 'superseded_at', v_now),
            current_user, p_actor_emp_id, 'record_application_version');
    v_no := v_latest.version_no + 1;
  END IF;

  INSERT INTO public.project_application_versions
    (tenant_id, project_id, version_no, snapshot, trigger, amount_before, amount_after, note, created_by_emp_id, created_at)
  VALUES (p_tenant_id, p_project_id, v_no, p_after_snapshot, p_trigger,
          CASE WHEN p_trigger = 'manual' THEN NULL ELSE p_amount_before END, p_amount_after, p_note, p_actor_emp_id, v_now)
  RETURNING id INTO v_id;
  INSERT INTO public.audit_logs (tenant_id, table_name, record_id, action, old_row, new_row, db_user, actor_emp_id, context)
  VALUES (p_tenant_id, 'project_application_versions', v_id, 'INSERT', NULL,
          jsonb_build_object('project_id', p_project_id, 'version_no', v_no, 'trigger', p_trigger,
                             'amount_before', CASE WHEN p_trigger = 'manual' THEN NULL ELSE p_amount_before END,
                             'amount_after', p_amount_after, 'note', p_note),
          current_user, p_actor_emp_id, 'record_application_version');
  RETURN v_no;
END;
$$;

REVOKE ALL ON FUNCTION public.record_application_version(uuid, uuid, text, jsonb, jsonb, numeric, numeric, text, uuid) FROM PUBLIC;
DO $$ BEGIN
  REVOKE ALL ON FUNCTION public.record_application_version(uuid, uuid, text, jsonb, jsonb, numeric, numeric, text, uuid) FROM anon, authenticated;
EXCEPTION WHEN undefined_object THEN NULL; END $$;
DO $$ BEGIN
  GRANT EXECUTE ON FUNCTION public.record_application_version(uuid, uuid, text, jsonb, jsonb, numeric, numeric, text, uuid) TO service_role;
EXCEPTION WHEN undefined_object THEN NULL; END $$;

COMMIT;
