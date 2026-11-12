-- 2026-11-12 刪除專案修正 2（migration 0097 ＝ sql/0087）：觸發器 soft 模式只放行「本句就是軟刪除」、已刪除列不能寫金額／日期、
--   原案只用 id 比對（新增 projects.replaced_by_project_id）、換案複製鏈改指向後繼案、先鎖子列再鎖專案（防死鎖）、audit 查詢帶 tenant。
-- 前提：已套 0096（docs/套用-2026-11-12-刪除專案-修正.sql）。
-- 只有 DDL（ADD COLUMN IF NOT EXISTS／CREATE INDEX IF NOT EXISTS／CREATE OR REPLACE FUNCTION／REVOKE／GRANT），冪等、包在交易內；不動任何資料列。
-- 必須「先套 DDL、再推程式」：新版 project-duplicate.ts 會寫 replaced_by_project_id，欄位不存在會 500。
-- 套用後跑 docs/驗證-2026-11-12-刪除專案-修正2.sql（正式庫只跑第 1 段唯讀檢查）。
-- 已用 db:replay（base 同 docs/套用-2026-11-12-刪除專案-修正.sql 所列，再加 --base-file docs/套用-2026-11-12-刪除專案-修正.sql）
--   在 pglite 上套兩遍（驗冪等）＋驗證全部通過。
BEGIN;

-- 2026-11-12 刪除專案修正 2（接 0096 ＝ sql/0086；本檔 ＝ sql/0087）：兩位獨立驗收的阻斷／重要／輕微項。
--
-- 1.【阻斷】assert_project_not_deleted 的 soft 模式：0096 只要 NEW.deleted_at 非空就放行——請款／開票／入帳／簽約／發票
--    先讀到活列、刪除交易把該列軟刪並提交後，UPDATE 在 READ COMMITTED 下重評 WHERE 仍成立，錢就寫進已刪除的列。改成：
--      • 只有「這次 UPDATE 本身就是軟刪除」（OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL）才放行，
--        且同一句不得改金額／日期欄位（否則 RD409 row_deleted）；
--      • 改「已刪除的列」：所屬專案已刪 → PD409；專案未刪但列已刪、又改了金額／日期欄位 → RD409（訊息 'row_deleted:'）；
--        只改備註、刪除原因等非金流欄位照常放行。
--    金額／日期欄位：project_billings（billed_on, billed_amount, invoice_no, invoiced_on, received_on, received_amount）、
--    contracts（amount, signed_on, stamp_duty_paid_on）、project_subcontracts（amount, invoice_no, invoice_date, withholding_date）。
-- 2.【重要】換案複製鏈 O→N1→N2：刪除已被 N2 取代的 N1 時，O 不還原，改指向 N2（archive_reason「已由 N2 取代：…」，
--    replaced_by_project_id＝N2，封存保留），避免 O 與 N2 同時計獎金。mode='repointed'。
-- 3.【重要】原案只用 id 比對：
--      a. projects.replaced_by_project_id（本檔新增；project-duplicate.ts 封存原案時寫入）＝本案；
--      b. 應用層稽核 'POST /projects/:id/duplicate (archive original)' 的 replaced_by＝本案，且原案目前的原因仍是當時寫的；
--      c. 本案建立時的稽核 'POST /projects/:id/duplicate'（archive_original＝true）的 duplicated_from，且原案原因仍以
--         「已由 {本案序號} 取代：」開頭（前綴只在 id 也吻合時採用）。
--    b／c 時若原案 replaced_by_project_id 已指向別案（又被複製了一次）就略過。
--    只有前綴吻合、id 對不上的案 → 不動，回 unverified 清單，API 告知「請手動檢查」。
-- 4.【輕微】死鎖：刪除改成先鎖子列（期程／合約／副委託，依 id）再鎖專案列，與「先鎖子列、觸發器再鎖專案」的寫入同序。
--    （API 另把 40P01／40001 轉成 409 conflict_retry。）
-- 5.【輕微】查 audit 快照帶 tenant_id。
--
-- 新增欄位 projects.replaced_by_project_id uuid（軟參照、不設 FK，同 parent_project_id）＋索引 (tenant_id, replaced_by_project_id)。
-- 前提：已套 0096（sql/0086）。只有 DDL（ADD COLUMN IF NOT EXISTS／CREATE INDEX IF NOT EXISTS／CREATE OR REPLACE FUNCTION），
-- 不動任何資料列（既有的取代關係不回填，靠 b／c 的稽核比對）；可重跑。觸發器掛載不變（沿用 0096）。

ALTER TABLE public.projects ADD COLUMN IF NOT EXISTS replaced_by_project_id uuid;
CREATE INDEX IF NOT EXISTS projects_tenant_replaced_by_idx ON public.projects (tenant_id, replaced_by_project_id);

CREATE OR REPLACE FUNCTION public.assert_project_not_deleted()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_mode text := coalesce(TG_ARGV[0], 'ref');
  v_project uuid;
  v_keys text[];
  v_old jsonb;
  v_new jsonb;
  v_money_changed boolean := false;
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

  IF v_mode = 'soft' AND TG_OP = 'UPDATE' THEN
    IF OLD.deleted_at IS NOT NULL OR NEW.deleted_at IS NOT NULL THEN
      v_keys := CASE TG_TABLE_NAME
        WHEN 'project_billings' THEN ARRAY['billed_on', 'billed_amount', 'invoice_no', 'invoiced_on', 'received_on', 'received_amount']
        WHEN 'contracts' THEN ARRAY['amount', 'signed_on', 'stamp_duty_paid_on']
        WHEN 'project_subcontracts' THEN ARRAY['amount', 'invoice_no', 'invoice_date', 'withholding_date']
        ELSE ARRAY[]::text[]
      END;
      v_old := to_jsonb(OLD);
      v_new := to_jsonb(NEW);
      SELECT EXISTS (SELECT 1 FROM unnest(v_keys) AS k WHERE (v_old -> k) IS DISTINCT FROM (v_new -> k)) INTO v_money_changed;
    END IF;
    IF OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL THEN
      -- 這次 UPDATE 就是軟刪除：放行（刪除本身不寫專案資料），但同一句不能夾帶金額／日期。
      IF v_money_changed THEN
        RAISE EXCEPTION 'row_deleted: 軟刪除時不能同時改金額／日期欄位（%）', TG_TABLE_NAME
          USING ERRCODE = 'RD409', DETAIL = NEW.id::text;
      END IF;
      RETURN NEW;
    END IF;
    IF OLD.deleted_at IS NOT NULL AND NEW.deleted_at IS NOT NULL THEN
      -- 改已刪除的列：專案已刪 → PD409；專案未刪但改了金額／日期 → RD409；其他（備註、刪除原因）放行。
      PERFORM 1 FROM public.projects p WHERE p.id = v_project AND p.deleted_at IS NULL FOR KEY SHARE;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'project_deleted: 專案已刪除，不能再寫入 %', TG_TABLE_NAME
          USING ERRCODE = 'PD409', DETAIL = v_project::text;
      END IF;
      IF v_money_changed THEN
        RAISE EXCEPTION 'row_deleted: 這一列已刪除，不能再寫入金額／日期（%）', TG_TABLE_NAME
          USING ERRCODE = 'RD409', DETAIL = NEW.id::text;
      END IF;
      RETURN NEW;
    END IF;
    -- 其餘（活列更新、把已刪除列救回來）照下面檢查專案。
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
  v_mode text;
  v_successor public.projects%ROWTYPE;
  v_has_successor boolean := false;
  v_matched uuid[] := ARRAY[]::uuid[];
  r record;
BEGIN
  IF p_tenant_id IS NULL OR p_project_id IS NULL THEN
    RETURN jsonb_build_object('status', 'not_found');
  END IF;

  -- 鎖順序（防死鎖）：先鎖子列（期程／合約／副委託，依 id），再鎖專案列——與「UPDATE 子列先鎖列、觸發器再對專案取
  -- FOR KEY SHARE」的寫入同序。專案列鎖住之後，子表的新寫入（觸發器）都要等本交易結束。
  PERFORM 1 FROM public.project_billings b WHERE b.tenant_id = p_tenant_id AND b.project_id = p_project_id ORDER BY b.id FOR UPDATE;
  PERFORM 1 FROM public.contracts c WHERE c.tenant_id = p_tenant_id AND c.project_id = p_project_id ORDER BY c.id FOR UPDATE;
  PERFORM 1 FROM public.project_subcontracts s WHERE s.tenant_id = p_tenant_id AND s.project_id = p_project_id ORDER BY s.id FOR UPDATE;
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
     LIMIT 1;
    v_has_successor := FOUND;
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
    v_prev := NULL;
    SELECT l.old_row INTO v_prev FROM public.audit_logs l
     WHERE l.tenant_id = p_tenant_id AND l.table_name = 'projects' AND l.record_id = r.id AND l.action = 'UPDATE'
       AND l.old_row ? 'archive_reason' AND l.old_row ? 'archived_at'
       AND l.new_row ->> 'archive_reason' = r.archive_reason
       AND (l.old_row ->> 'archive_reason') IS DISTINCT FROM r.archive_reason
     ORDER BY l.at DESC
     LIMIT 1;
    IF v_prev IS NOT NULL THEN
      v_mode := 'restored';
      v_new_reason := v_prev ->> 'archive_reason';
      v_new_archived_at := CASE WHEN r.archived_at IS NULL THEN NULL ELSE (v_prev ->> 'archived_at')::timestamptz END;
    ELSE
      v_mode := 'unmarked';
      v_new_reason := '原取代案 ' || coalesce(v_project.code, v_project.name) || ' 已刪除，已解除取代標記（封存保留，需要時請自行解除封存）';
      v_new_archived_at := r.archived_at;
    END IF;
    UPDATE public.projects
       SET archive_reason = v_new_reason, archived_at = v_new_archived_at, replaced_by_project_id = NULL
     WHERE id = r.id;
    v_restored := v_restored || jsonb_build_object(
      'id', r.id, 'code', r.code, 'mode', v_mode, 'archived', v_new_archived_at IS NOT NULL);
  END LOOP;

  -- 只有序號前綴吻合、id 對不上（可能是改號後被重用、或手填相同字樣、或當時稽核沒寫成）→ 不動，請使用者手動檢查。
  IF v_prefix IS NOT NULL THEN
    SELECT coalesce(jsonb_agg(jsonb_build_object('id', p.id, 'code', p.code) ORDER BY p.id), '[]'::jsonb) INTO v_unverified
      FROM public.projects p
     WHERE p.tenant_id = p_tenant_id AND p.id <> p_project_id AND p.deleted_at IS NULL
       AND starts_with(p.archive_reason, v_prefix) AND NOT (p.id = ANY (v_matched));
  END IF;

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

COMMIT;
