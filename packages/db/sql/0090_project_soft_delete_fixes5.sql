-- 2026-11-12 刪除專案修正 5（接 0099 ＝ sql/0089；本檔 ＝ sql/0090）：第五輪獨立驗收（DB 層）。
--
-- 1. 已作廢（void）放款單的分攤不算擋刪：作廢單不能刪、分攤也不能刪（forbid_delete_unless_draft_disbursement），
--    不排除的話專案／副委託永遠刪不掉。擋刪條件與連帶軟刪除副委託的條件都改成只看 status <> 'void' 的放款單；
--    草稿、送簽中、已核准、已匯款仍算（與 TS 預檢、副委託 PUT 移除一致）。
-- 2. 分叉鏈死鎖：預先依 id 鎖住的集合再加入「原案 audit 快照中的 replaced_by_project_id」所指專案。
-- 前提：已套 0099（sql/0089）。只有 DDL（CREATE OR REPLACE FUNCTION soft_delete_project／REVOKE／GRANT），
-- 不動任何資料列；可重跑。觸發器函式 assert_project_not_deleted 不變（沿用 0099）。

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
