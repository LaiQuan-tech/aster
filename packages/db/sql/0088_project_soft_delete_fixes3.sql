-- 2026-11-12 刪除專案修正 3（接 0097 ＝ sql/0087；本檔 ＝ sql/0088）：第三輪獨立驗收。
--
-- R1【重要】還原原案的快照只採用「還原後狀態合法」的那筆：舊原因不是取代原因；或舊原因是取代原因、且快照裡的
--    replaced_by_project_id 指向未刪除、非本案、非原案自己的案（同步把 replaced_by 指回它）。否則往前找，找不到走 unmarked。
--    （換案鏈 O→N1→N2 先刪 N1 再刪 N2，原本會把 O 設回「已由 N1 取代」且 replaced_by 清空，O 永遠被排除獎金。）
-- 4. 刪除時子列改用 FOR NO KEY UPDATE（不與外鍵檢查的 FOR KEY SHARE 互斥），仍依 id 排序。
-- 5. 查本案的後繼案加 FOR SHARE（仍限 deleted_at IS NULL）：同時刪 N1、N2 時排隊。
-- 6. 已刪除列的金額／日期欄位補齊：project_billings 加 override_amount、calculated_amount、residue_applied、percentage、
--    planned_on；contracts 加 stamp_duty_amount、stamp_duty_rate。只對「已刪除的列」生效：活專案的活列（試算重算
--    recomputeBillings 改 calculated_amount 等）不受影響。
-- 7. 副委託期款（payment 模式）：所屬副委託已軟刪除 → 不能新增期款、不能改付款／驗收／金額（RD409）。
-- 8. projects 加 CHECK projects_replaced_by_not_self_chk（replaced_by_project_id <> id）；函式遇到環（後繼案指回本案、
--    原案就是後繼案）就跳過，列 unverified。
-- 前提：已套 0097（sql/0087）。只有 DDL（ADD CONSTRAINT（不存在才加）／CREATE OR REPLACE FUNCTION／REVOKE／GRANT），
-- 不動任何資料列；可重跑。CHECK 加上時會檢查現有列（正式庫 replaced_by_project_id 全為 null）。觸發器掛載不變（沿用 0096）。

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'projects_replaced_by_not_self_chk') THEN
    ALTER TABLE public.projects ADD CONSTRAINT projects_replaced_by_not_self_chk
      CHECK (replaced_by_project_id IS NULL OR replaced_by_project_id <> id);
  END IF;
END $$;

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
  v_sub_deleted timestamptz;
BEGIN
  IF v_mode = 'payment' THEN
    SELECT s.project_id, s.deleted_at INTO v_project, v_sub_deleted FROM public.project_subcontracts s WHERE s.id = NEW.subcontract_id;
    -- 所屬副委託已軟刪除：不能新增期款，也不能改付款／驗收／金額（RD409）；只改備註等放行（仍要檢查專案）。
    IF v_sub_deleted IS NOT NULL THEN
      IF TG_OP = 'INSERT' THEN
        RAISE EXCEPTION 'row_deleted: 副委託已刪除，不能新增期款' USING ERRCODE = 'RD409', DETAIL = NEW.subcontract_id::text;
      END IF;
      v_old := to_jsonb(OLD);
      v_new := to_jsonb(NEW);
      SELECT EXISTS (
        SELECT 1 FROM unnest(ARRAY['paid_on', 'paid_amount', 'accepted_on', 'accepted_by_emp_id', 'withheld_amount',
                                   'amount', 'override_amount', 'disbursement_id']) AS k
         WHERE (v_old -> k) IS DISTINCT FROM (v_new -> k)) INTO v_money_changed;
      IF v_money_changed THEN
        RAISE EXCEPTION 'row_deleted: 副委託已刪除，不能再寫入期款的付款／驗收／金額' USING ERRCODE = 'RD409', DETAIL = NEW.id::text;
      END IF;
    END IF;
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
        WHEN 'project_billings' THEN ARRAY['billed_on', 'billed_amount', 'invoice_no', 'invoiced_on', 'received_on', 'received_amount',
                                           'override_amount', 'calculated_amount', 'residue_applied', 'percentage', 'planned_on']
        WHEN 'contracts' THEN ARRAY['amount', 'signed_on', 'stamp_duty_paid_on', 'stamp_duty_amount', 'stamp_duty_rate']
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
  v_new_replaced_by uuid;
  v_mode text;
  v_successor public.projects%ROWTYPE;
  v_has_successor boolean := false;
  v_matched uuid[] := ARRAY[]::uuid[];
  v_cycle boolean := false;
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
     LIMIT 1
     FOR SHARE OF x;
    v_has_successor := FOUND;
    -- 後繼案自己指回本案（環）：不當作後繼案。
    IF v_has_successor AND v_successor.replaced_by_project_id = p_project_id THEN
      v_has_successor := false;
      v_cycle := true;
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
    IF (v_has_successor AND r.id = v_successor.id) OR (v_cycle AND r.id = v_project.replaced_by_project_id) THEN
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
    v_prev := NULL;
    -- 只採用「還原後狀態合法」的快照（換案鏈 O→N1→N2 先刪 N1 再刪 N2 時，最新快照的舊值是「已由 N1 取代」）：
    --   • 舊原因不是取代原因 → 可以還原（replaced_by 清空）；
    --   • 舊原因是取代原因 → 只有快照裡的 replaced_by_project_id 指向「未刪除、不是本案、不是原案自己」的案才可以，
    --     並同步把 replaced_by 指回那一案；否則跳過這筆快照往前找。
    SELECT l.old_row INTO v_prev FROM public.audit_logs l
     WHERE l.tenant_id = p_tenant_id AND l.table_name = 'projects' AND l.record_id = r.id AND l.action = 'UPDATE'
       AND l.old_row ? 'archive_reason' AND l.old_row ? 'archived_at'
       AND l.new_row ->> 'archive_reason' = r.archive_reason
       AND (l.old_row ->> 'archive_reason') IS DISTINCT FROM r.archive_reason
       AND (NOT coalesce(l.old_row ->> 'archive_reason', '') ~ '^已由 .+ 取代：'
            OR EXISTS (SELECT 1 FROM public.projects z
                        WHERE z.tenant_id = p_tenant_id AND z.deleted_at IS NULL
                          AND z.id::text = l.old_row ->> 'replaced_by_project_id'
                          AND z.id <> p_project_id AND z.id <> r.id))
     ORDER BY l.at DESC
     LIMIT 1;
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
