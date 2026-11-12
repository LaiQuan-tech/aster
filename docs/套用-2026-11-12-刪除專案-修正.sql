-- 2026-11-12 刪除專案修正（migration 0096 ＝ sql/0086）：soft_delete_project 原子刪除函式＋「已刪除專案不能再寫入」觸發器。
-- 前提：已套 0095（sql/0085，docs/套用-2026-11-12-刪除專案.sql）。
-- 只有 DDL（CREATE OR REPLACE FUNCTION／DROP TRIGGER IF EXISTS 後重建／REVOKE／GRANT），冪等、包在交易內；不動任何資料列。
-- 套用後跑 docs/驗證-2026-11-12-刪除專案-修正.sql（正式庫只跑第 1 段唯讀檢查）。
-- 必須「先套 DDL、再推程式」：新版 API 的 DELETE /projects/:id 走 rpc soft_delete_project，函式不存在會 500。
-- 已用 `npm run db:replay -- --base-migration 53 --base-sql 62 --base-file docs/套用-2026-11-08-薪資津貼勞退.sql
--   --base-file docs/套用-2026-11-08-加班基數.sql --base-file docs/套用-2026-11-10-薪資投保歷程.sql
--   --base-file docs/套用-2026-11-10-副委託事務所與發票.sql --base-file docs/套用-2026-11-10-申請單版本.sql
--   --base-file docs/套用-2026-11-11-每期獎金分潤.sql --base-file docs/套用-2026-11-11-每期獎金分潤-修正.sql
--   --base-file docs/套用-2026-11-11-每期獎金分潤-修正2.sql --base-file docs/套用-2026-11-12-專案序號手動.sql
--   --base-file docs/套用-2026-11-12-刪除專案.sql
--   docs/套用-2026-11-12-刪除專案-修正.sql --verify docs/驗證-2026-11-12-刪除專案-修正.sql` 在 pglite 上套兩遍（驗冪等）＋驗證全部通過。
BEGIN;

-- 2026-11-12 刪除專案修正（接 0095 ＝ sql/0085；本檔 ＝ sql/0086）：刪除改成 DB 層原子處理＋已刪除專案不能再寫入子表。
--
-- 1. soft_delete_project(p_tenant_id, p_project_id, p_actor_emp_id, p_reason) → jsonb
--    同一交易內：SELECT … FOR UPDATE 鎖住專案列 → 重新檢查全部擋刪條件（與 apps/api/src/services/project-delete.ts
--    的 planProjectDelete 一致）→ 有任何一項回 {status:'blocked', blockers:[{key,count}]}，什麼都不動；
--    否則：連帶軟刪除「沒有請款／開票／入帳的期程」「未簽約未繳印花稅的合約」「沒有發票、沒有代扣、沒有已付／已驗收期款、
--    沒有放款分攤的副委託」→ 還原「被本案取代而封存」的原案（見 3）→ 最後才標記專案 deleted_at／deleted_by_emp_id。
--    回 {status:'deleted', id, code, cascade:{billings,contracts,subcontracts}, restored:[{id,code,mode,archived}]}；
--    專案不存在／別租戶／已刪除回 {status:'not_found'}。
--    security definer＋search_path＝public, pg_temp；revoke PUBLIC／anon／authenticated，只給 service_role。
--
-- 2. assert_project_not_deleted()：BEFORE INSERT/UPDATE 觸發器，所屬專案已刪除就 RAISE（ERRCODE 'PD409'，
--    訊息以 'project_deleted:' 開頭；API 全域錯誤處理對應成 409 project_deleted）。檢查時以 FOR KEY SHARE 鎖專案列：
--    與刪除函式的 FOR UPDATE 互斥（刪除進行中，寫入等它提交後重新判斷→擋下；寫入先 → 刪除等寫入提交後才檢查→看得到新資料而擋刪），
--    但和一般 PATCH 專案（FOR NO KEY UPDATE）不互斥——外鍵檢查本來就會對專案列取同一種鎖，不增加新的等待。
--    掛載：
--      soft（INSERT＋任何 UPDATE；UPDATE 後仍是已軟刪除的列放行）：project_billings、contracts、project_subcontracts
--      payment（INSERT＋任何 UPDATE；經副委託找專案）：project_subcontract_payments
--      ref（INSERT＋UPDATE OF project_id；這些表只要有列就擋刪，所以只需攔「新掛上」）：
--        disbursement_allocations、attendance_sheet_days、bonus_run_items、project_billing_shares、
--        project_billing_bonus_dates、project_share_adjustments、project_documents
--      parent（projects：INSERT／UPDATE OF parent_project_id，且 parent_project_id 非空）：不能把子案掛到已刪除的母案
--
-- 3. 刪除「換案複製」出來的新案時，原案（archive_reason＝「已由 {本案序號} 取代：…」，或應用層稽核
--    context 'POST /projects/:id/duplicate (archive original)' 的 replaced_by＝本案）若仍是當時寫的取代原因：
--      • audit_all 觸發器留有複製前的整列快照 → 回復 archive_reason／archived_at 到複製前（之後若已手動解封則維持解封）；mode='restored'
--      • 找不到快照 → 保留封存、archive_reason 改成「原取代案 X 已刪除…」解除取代標記，讓業主自行決定是否解封；mode='unmarked'
--    （獎金批次 isDuplicateReplacedArchive 只認「已由 … 取代：」開頭，解除後原案重新納入。）
--
-- 前提：已套 0095（sql/0085）。只有 DDL（函式／觸發器），不動任何資料列；可重跑（CREATE OR REPLACE／DROP TRIGGER IF EXISTS）。

CREATE OR REPLACE FUNCTION public.assert_project_not_deleted()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_mode text := coalesce(TG_ARGV[0], 'ref');
  v_project uuid;
BEGIN
  IF v_mode = 'payment' THEN
    SELECT s.project_id INTO v_project FROM public.project_subcontracts s WHERE s.id = NEW.subcontract_id;
  ELSIF v_mode = 'parent' THEN
    v_project := NEW.parent_project_id;
  ELSE
    v_project := NEW.project_id;
  END IF;
  IF v_project IS NULL THEN
    RETURN NEW;
  END IF;
  -- 已軟刪除的列（把自己刪掉、或改動已刪除的列）不是「寫入活資料」，放行。
  IF v_mode = 'soft' AND TG_OP = 'UPDATE' THEN
    IF NEW.deleted_at IS NOT NULL THEN
      RETURN NEW;
    END IF;
  END IF;
  PERFORM 1 FROM public.projects p WHERE p.id = v_project AND p.deleted_at IS NULL FOR KEY SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'project_deleted: 專案已刪除，不能再寫入 %', TG_TABLE_NAME
      USING ERRCODE = 'PD409', DETAIL = v_project::text;
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.assert_project_not_deleted() FROM PUBLIC;
DO $$ BEGIN
  REVOKE ALL ON FUNCTION public.assert_project_not_deleted() FROM anon, authenticated;
EXCEPTION WHEN undefined_object THEN NULL; END $$;

DROP TRIGGER IF EXISTS project_not_deleted_guard ON public.project_billings;
CREATE TRIGGER project_not_deleted_guard BEFORE INSERT OR UPDATE ON public.project_billings
  FOR EACH ROW EXECUTE FUNCTION public.assert_project_not_deleted('soft');
DROP TRIGGER IF EXISTS project_not_deleted_guard ON public.contracts;
CREATE TRIGGER project_not_deleted_guard BEFORE INSERT OR UPDATE ON public.contracts
  FOR EACH ROW EXECUTE FUNCTION public.assert_project_not_deleted('soft');
DROP TRIGGER IF EXISTS project_not_deleted_guard ON public.project_subcontracts;
CREATE TRIGGER project_not_deleted_guard BEFORE INSERT OR UPDATE ON public.project_subcontracts
  FOR EACH ROW EXECUTE FUNCTION public.assert_project_not_deleted('soft');
DROP TRIGGER IF EXISTS project_not_deleted_guard ON public.project_subcontract_payments;
CREATE TRIGGER project_not_deleted_guard BEFORE INSERT OR UPDATE ON public.project_subcontract_payments
  FOR EACH ROW EXECUTE FUNCTION public.assert_project_not_deleted('payment');
DROP TRIGGER IF EXISTS project_not_deleted_guard ON public.disbursement_allocations;
CREATE TRIGGER project_not_deleted_guard BEFORE INSERT OR UPDATE OF project_id ON public.disbursement_allocations
  FOR EACH ROW EXECUTE FUNCTION public.assert_project_not_deleted('ref');
DROP TRIGGER IF EXISTS project_not_deleted_guard ON public.attendance_sheet_days;
CREATE TRIGGER project_not_deleted_guard BEFORE INSERT OR UPDATE OF project_id ON public.attendance_sheet_days
  FOR EACH ROW EXECUTE FUNCTION public.assert_project_not_deleted('ref');
DROP TRIGGER IF EXISTS project_not_deleted_guard ON public.bonus_run_items;
CREATE TRIGGER project_not_deleted_guard BEFORE INSERT OR UPDATE OF project_id ON public.bonus_run_items
  FOR EACH ROW EXECUTE FUNCTION public.assert_project_not_deleted('ref');
DROP TRIGGER IF EXISTS project_not_deleted_guard ON public.project_billing_shares;
CREATE TRIGGER project_not_deleted_guard BEFORE INSERT OR UPDATE OF project_id ON public.project_billing_shares
  FOR EACH ROW EXECUTE FUNCTION public.assert_project_not_deleted('ref');
DROP TRIGGER IF EXISTS project_not_deleted_guard ON public.project_billing_bonus_dates;
CREATE TRIGGER project_not_deleted_guard BEFORE INSERT OR UPDATE OF project_id ON public.project_billing_bonus_dates
  FOR EACH ROW EXECUTE FUNCTION public.assert_project_not_deleted('ref');
DROP TRIGGER IF EXISTS project_not_deleted_guard ON public.project_share_adjustments;
CREATE TRIGGER project_not_deleted_guard BEFORE INSERT OR UPDATE OF project_id ON public.project_share_adjustments
  FOR EACH ROW EXECUTE FUNCTION public.assert_project_not_deleted('ref');
DROP TRIGGER IF EXISTS project_not_deleted_guard ON public.project_documents;
CREATE TRIGGER project_not_deleted_guard BEFORE INSERT OR UPDATE OF project_id ON public.project_documents
  FOR EACH ROW EXECUTE FUNCTION public.assert_project_not_deleted('ref');
DROP TRIGGER IF EXISTS project_parent_not_deleted_guard ON public.projects;
CREATE TRIGGER project_parent_not_deleted_guard BEFORE INSERT OR UPDATE OF parent_project_id ON public.projects
  FOR EACH ROW WHEN (NEW.parent_project_id IS NOT NULL)
  EXECUTE FUNCTION public.assert_project_not_deleted('parent');

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
  v_prefix text;
  v_prev jsonb;
  v_new_reason text;
  v_new_archived_at timestamptz;
  v_mode text;
  r record;
BEGIN
  IF p_tenant_id IS NULL OR p_project_id IS NULL THEN
    RETURN jsonb_build_object('status', 'not_found');
  END IF;

  -- 鎖專案列：之後子表寫入（觸發器 FOR KEY SHARE）都要等本交易結束；本交易開始前已在寫的，這裡會等它提交。
  SELECT * INTO v_project FROM public.projects
   WHERE tenant_id = p_tenant_id AND id = p_project_id AND deleted_at IS NULL
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('status', 'not_found');
  END IF;

  -- ── 擋刪條件（順序與 project-delete.ts DeleteBlockerKey 一致） ──
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

  SELECT count(*) INTO v_n FROM public.project_share_adjustments a WHERE a.tenant_id = p_tenant_id AND a.project_id = p_project_id;
  IF v_n > 0 THEN v_blockers := v_blockers || jsonb_build_object('key', 'share_adjustments', 'count', v_n); END IF;

  SELECT count(*) INTO v_n FROM public.attendance_sheet_days d WHERE d.tenant_id = p_tenant_id AND d.project_id = p_project_id;
  IF v_n > 0 THEN v_blockers := v_blockers || jsonb_build_object('key', 'attendance_days', 'count', v_n); END IF;

  SELECT count(DISTINCT x.id) INTO v_n FROM public.disbursement_allocations x
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
     AND NOT EXISTS (SELECT 1 FROM public.disbursement_allocations x WHERE x.subcontract_id = s.id);
  GET DIAGNOSTICS v_subs = ROW_COUNT;

  -- ── 還原被本案取代而封存的原案 ──
  v_prefix := CASE WHEN v_project.code IS NULL THEN NULL ELSE '已由 ' || v_project.code || ' 取代：' END;
  FOR r IN
    SELECT p.id, p.code, p.archived_at, p.archive_reason
      FROM public.projects p
     WHERE p.tenant_id = p_tenant_id AND p.id <> p_project_id AND p.deleted_at IS NULL
       AND p.archive_reason ~ '^已由 .+ 取代：'
       AND ((v_prefix IS NOT NULL AND starts_with(p.archive_reason, v_prefix))
            OR EXISTS (SELECT 1 FROM public.audit_logs l
                        WHERE l.tenant_id = p_tenant_id AND l.table_name = 'projects' AND l.record_id = p.id
                          AND l.context = 'POST /projects/:id/duplicate (archive original)'
                          AND l.new_row ->> 'replaced_by' = p_project_id::text
                          AND l.new_row ->> 'archive_reason' = p.archive_reason))
     ORDER BY p.id
     FOR UPDATE OF p
  LOOP
    -- audit_all（AFTER UPDATE）留下的整列快照：寫入這個取代原因的那一次更新，取它的舊值。
    SELECT l.old_row INTO v_prev FROM public.audit_logs l
     WHERE l.table_name = 'projects' AND l.record_id = r.id AND l.action = 'UPDATE'
       AND l.old_row ? 'archive_reason' AND l.old_row ? 'archived_at'
       AND l.new_row ->> 'archive_reason' = r.archive_reason
       AND (l.old_row ->> 'archive_reason') IS DISTINCT FROM r.archive_reason
     ORDER BY l.at DESC
     LIMIT 1;
    IF v_prev IS NOT NULL THEN
      v_mode := 'restored';
      v_new_reason := v_prev ->> 'archive_reason';
      -- 複製後已被手動解封（archived_at 已是 null）就維持解封，不要又封回去。
      v_new_archived_at := CASE WHEN r.archived_at IS NULL THEN NULL ELSE (v_prev ->> 'archived_at')::timestamptz END;
    ELSE
      v_mode := 'unmarked';
      v_new_reason := '原取代案 ' || coalesce(v_project.code, v_project.name) || ' 已刪除，已解除取代標記（封存保留，需要時請自行解除封存）';
      v_new_archived_at := r.archived_at;
    END IF;
    UPDATE public.projects SET archive_reason = v_new_reason, archived_at = v_new_archived_at WHERE id = r.id;
    v_restored := v_restored || jsonb_build_object(
      'id', r.id, 'code', r.code, 'mode', v_mode, 'archived', v_new_archived_at IS NOT NULL);
    v_prev := NULL;
  END LOOP;

  UPDATE public.projects SET deleted_at = v_now, deleted_by_emp_id = p_actor_emp_id WHERE id = p_project_id;

  RETURN jsonb_build_object(
    'status', 'deleted',
    'id', v_project.id,
    'code', v_project.code,
    'cascade', jsonb_build_object('billings', v_billings, 'contracts', v_contracts, 'subcontracts', v_subs),
    'restored', v_restored
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

COMMIT;
