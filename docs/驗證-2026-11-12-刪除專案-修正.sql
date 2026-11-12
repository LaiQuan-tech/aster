-- 2026-11-12 刪除專案修正（migration 0096 ＝ sql/0086）套用後驗證。ok 欄全為 true 才算通過。
-- 第 1 段：唯讀結構檢查（一個查詢回一張表；正式庫在前面加 `set transaction read only;` 執行）。
-- 第 2 段：交易內實測（最後 ROLLBACK，不留任何資料；在 pglite（npm run db:replay）上跑，正式庫略過）。

-- 1. 結構：兩個函式 security definer＋search_path、權限只給 service_role、觸發器掛在 12 張表、現有專案沒有違規子列
SELECT item, ok, detail FROM (
  SELECT 1 AS seq, 'soft_delete_project：security definer＋search_path＋FOR UPDATE＋擋刪條件含副委託已付／已驗收／代扣' AS item,
         count(*) = 1 AND bool_and(p.prosecdef AND array_to_string(p.proconfig, ',') LIKE '%search_path=public, pg_temp%'
                  AND pg_get_functiondef(p.oid) LIKE '%FOR UPDATE%'
                  AND pg_get_functiondef(p.oid) LIKE '%paid_subcontract_payments%'
                  AND pg_get_functiondef(p.oid) LIKE '%withheld_subcontracts%'
                  AND pg_get_functiondef(p.oid) LIKE '%accepted_on%') AS ok,
         string_agg(pg_get_function_identity_arguments(p.oid), ' | ') AS detail
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'soft_delete_project'
  UNION ALL
  SELECT 2, 'assert_project_not_deleted：security definer＋search_path＋FOR KEY SHARE＋errcode PD409',
         count(*) = 1 AND bool_and(p.prosecdef AND array_to_string(p.proconfig, ',') LIKE '%search_path=public, pg_temp%'
                  AND pg_get_functiondef(p.oid) LIKE '%FOR KEY SHARE%'
                  AND pg_get_functiondef(p.oid) LIKE '%PD409%'),
         NULL
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'assert_project_not_deleted'
  UNION ALL
  SELECT 3, '執行權限：soft_delete_project 只有 service_role；兩個函式 PUBLIC／anon／authenticated 都沒有',
         (NOT has_function_privilege('anon', 'public.soft_delete_project(uuid, uuid, uuid, text)', 'EXECUTE')
          AND NOT has_function_privilege('authenticated', 'public.soft_delete_project(uuid, uuid, uuid, text)', 'EXECUTE')
          AND has_function_privilege('service_role', 'public.soft_delete_project(uuid, uuid, uuid, text)', 'EXECUTE')
          AND NOT has_function_privilege('anon', 'public.assert_project_not_deleted()', 'EXECUTE')
          AND NOT has_function_privilege('authenticated', 'public.assert_project_not_deleted()', 'EXECUTE')
          AND NOT EXISTS (
            SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
             WHERE n.nspname = 'public' AND p.proname IN ('soft_delete_project', 'assert_project_not_deleted')
               AND a.grantee = 0 AND a.privilege_type = 'EXECUTE')),
         NULL
  UNION ALL
  SELECT 4, '觸發器：12 張表都掛上（BEFORE、FOR EACH ROW、參數 soft／payment／ref／parent 對應正確）',
         count(*) = 12 AND bool_and(
           CASE c.relname
             WHEN 'project_billings' THEN d LIKE 'CREATE TRIGGER project_not_deleted_guard BEFORE INSERT OR UPDATE ON %' AND d LIKE '%(''soft'')'
             WHEN 'contracts' THEN d LIKE 'CREATE TRIGGER project_not_deleted_guard BEFORE INSERT OR UPDATE ON %' AND d LIKE '%(''soft'')'
             WHEN 'project_subcontracts' THEN d LIKE 'CREATE TRIGGER project_not_deleted_guard BEFORE INSERT OR UPDATE ON %' AND d LIKE '%(''soft'')'
             WHEN 'project_subcontract_payments' THEN d LIKE '%BEFORE INSERT OR UPDATE ON %' AND d LIKE '%(''payment'')'
             WHEN 'projects' THEN d LIKE 'CREATE TRIGGER project_parent_not_deleted_guard BEFORE INSERT OR UPDATE OF parent_project_id ON %' AND d LIKE '%(''parent'')'
             ELSE d LIKE 'CREATE TRIGGER project_not_deleted_guard BEFORE INSERT OR UPDATE OF project_id ON %' AND d LIKE '%(''ref'')'
           END),
         string_agg(c.relname, ', ' ORDER BY c.relname)
    FROM (SELECT t.tgrelid, pg_get_triggerdef(t.oid) AS d FROM pg_trigger t
           WHERE NOT t.tgisinternal AND t.tgname IN ('project_not_deleted_guard', 'project_parent_not_deleted_guard')) x
    JOIN pg_class c ON c.oid = x.tgrelid
   WHERE c.relname IN ('project_billings', 'contracts', 'project_subcontracts', 'project_subcontract_payments',
                       'disbursement_allocations', 'attendance_sheet_days', 'bonus_run_items', 'project_billing_shares',
                       'project_billing_bonus_dates', 'project_share_adjustments', 'project_documents', 'projects')
  UNION ALL
  SELECT 5, '既有資料不受影響：沒有任何「活」子列掛在已刪除的專案上（期程／合約／副委託／分攤／工時／獎金／文件／子案）',
         (SELECT count(*) FROM public.projects p WHERE p.deleted_at IS NOT NULL AND (
            EXISTS (SELECT 1 FROM public.project_billings b WHERE b.project_id = p.id AND b.deleted_at IS NULL)
            OR EXISTS (SELECT 1 FROM public.contracts c WHERE c.project_id = p.id AND c.deleted_at IS NULL)
            OR EXISTS (SELECT 1 FROM public.project_subcontracts s WHERE s.project_id = p.id AND s.deleted_at IS NULL)
            OR EXISTS (SELECT 1 FROM public.disbursement_allocations x WHERE x.project_id = p.id)
            OR EXISTS (SELECT 1 FROM public.attendance_sheet_days d WHERE d.project_id = p.id)
            OR EXISTS (SELECT 1 FROM public.bonus_run_items i WHERE i.project_id = p.id)
            OR EXISTS (SELECT 1 FROM public.project_documents d WHERE d.project_id = p.id)
            OR EXISTS (SELECT 1 FROM public.projects k WHERE k.parent_project_id = p.id AND k.deleted_at IS NULL))) = 0,
         (SELECT count(*) || ' 專案／' || count(*) FILTER (WHERE deleted_at IS NOT NULL) || ' 已刪除' FROM public.projects)
) t ORDER BY seq;

-- 2. 實測（pglite）：擋刪條件、連帶軟刪除、原案還原、刪除後子表寫入一律 PD409。回一張 ok 表，最後 ROLLBACK 不留資料。
BEGIN;
INSERT INTO public.tenants (id, name, status) VALUES ('f0000000-0000-4000-8000-0000000000e1', '測試租戶刪除修正', 'active');
INSERT INTO public.employees (id, tenant_id, name) VALUES ('f0000000-0000-4000-8000-0000000000e2', 'f0000000-0000-4000-8000-0000000000e1', '測試老闆');
INSERT INTO public.projects (id, tenant_id, name, code) VALUES
  ('f0000000-0000-4000-8000-00000000a001', 'f0000000-0000-4000-8000-0000000000e1', '空殼案', 'ZZ-FIX-A'),
  ('f0000000-0000-4000-8000-00000000a002', 'f0000000-0000-4000-8000-0000000000e1', '副委託已驗收', 'ZZ-FIX-B'),
  ('f0000000-0000-4000-8000-00000000a003', 'f0000000-0000-4000-8000-0000000000e1', '事務所已代扣', 'ZZ-FIX-C'),
  ('f0000000-0000-4000-8000-00000000a004', 'f0000000-0000-4000-8000-0000000000e1', '期程已請款', 'ZZ-FIX-D'),
  ('f0000000-0000-4000-8000-00000000a005', 'f0000000-0000-4000-8000-0000000000e1', '原案（未封存）', 'ZZ-FIX-O1'),
  ('f0000000-0000-4000-8000-00000000a006', 'f0000000-0000-4000-8000-0000000000e1', '換案新案一', 'ZZ-FIX-N1'),
  ('f0000000-0000-4000-8000-00000000a007', 'f0000000-0000-4000-8000-0000000000e1', '原案（早已手動封存）', 'ZZ-FIX-O2'),
  ('f0000000-0000-4000-8000-00000000a008', 'f0000000-0000-4000-8000-0000000000e1', '換案新案二', 'ZZ-FIX-N2'),
  ('f0000000-0000-4000-8000-00000000a00a', 'f0000000-0000-4000-8000-0000000000e1', '換案新案三', 'ZZ-FIX-N3'),
  ('f0000000-0000-4000-8000-00000000a00b', 'f0000000-0000-4000-8000-0000000000e1', '副委託已付款', 'ZZ-FIX-E');
-- 沒有 UPDATE 快照的原案（建立時就帶取代原因）→ 只能解除標記、保留封存
INSERT INTO public.projects (id, tenant_id, name, code, archived_at, archive_reason) VALUES
  ('f0000000-0000-4000-8000-00000000a009', 'f0000000-0000-4000-8000-0000000000e1', '原案（無快照）', 'ZZ-FIX-O3',
   '2026-10-01T00:00:00Z', '已由 ZZ-FIX-N3 取代：換案');
-- A：計畫期程、草稿合約、無發票副委託＋未付期款 → 可刪
INSERT INTO public.project_billings (id, tenant_id, project_id, installment_no) VALUES
  ('f0000000-0000-4000-8000-00000000b001', 'f0000000-0000-4000-8000-0000000000e1', 'f0000000-0000-4000-8000-00000000a001', 1);
INSERT INTO public.contracts (id, tenant_id, project_id, doc_type, title) VALUES
  ('f0000000-0000-4000-8000-00000000c001', 'f0000000-0000-4000-8000-0000000000e1', 'f0000000-0000-4000-8000-00000000a001', 'contract', '草稿合約');
INSERT INTO public.project_subcontracts (id, tenant_id, project_id) VALUES
  ('f0000000-0000-4000-8000-00000000d001', 'f0000000-0000-4000-8000-0000000000e1', 'f0000000-0000-4000-8000-00000000a001');
INSERT INTO public.project_subcontract_payments (tenant_id, subcontract_id, installment_no) VALUES
  ('f0000000-0000-4000-8000-0000000000e1', 'f0000000-0000-4000-8000-00000000d001', 1);
-- B：副委託期款已驗收；E：副委託期款已付款；C：事務所已代扣；D：期程已請款
INSERT INTO public.project_subcontracts (id, tenant_id, project_id) VALUES
  ('f0000000-0000-4000-8000-00000000d002', 'f0000000-0000-4000-8000-0000000000e1', 'f0000000-0000-4000-8000-00000000a002'),
  ('f0000000-0000-4000-8000-00000000d004', 'f0000000-0000-4000-8000-0000000000e1', 'f0000000-0000-4000-8000-00000000a00b');
INSERT INTO public.project_subcontract_payments (tenant_id, subcontract_id, installment_no, accepted_on) VALUES
  ('f0000000-0000-4000-8000-0000000000e1', 'f0000000-0000-4000-8000-00000000d002', 1, '2026-11-01');
INSERT INTO public.project_subcontract_payments (tenant_id, subcontract_id, installment_no, paid_on, paid_amount) VALUES
  ('f0000000-0000-4000-8000-0000000000e1', 'f0000000-0000-4000-8000-00000000d004', 1, '2026-11-02', 1000);
INSERT INTO public.project_subcontracts (id, tenant_id, project_id, kind, withholding_date) VALUES
  ('f0000000-0000-4000-8000-00000000d003', 'f0000000-0000-4000-8000-0000000000e1', 'f0000000-0000-4000-8000-00000000a003', 'firm', '2026-11-03');
INSERT INTO public.project_billings (tenant_id, project_id, installment_no, billed_on, billed_amount) VALUES
  ('f0000000-0000-4000-8000-0000000000e1', 'f0000000-0000-4000-8000-00000000a004', 1, '2026-11-04', 1000);
-- 模擬換案複製（project-duplicate.ts 第 6 步）：O1 原本未封存；O2 早已手動封存（封存日不覆寫，只改原因）
UPDATE public.projects SET archive_reason = '已由 ZZ-FIX-N1 取代：換案', archived_at = now()
 WHERE id = 'f0000000-0000-4000-8000-00000000a005';
UPDATE public.projects SET archive_reason = '手動封存', archived_at = '2026-09-01T00:00:00Z'
 WHERE id = 'f0000000-0000-4000-8000-00000000a007';
UPDATE public.projects SET archive_reason = '已由 ZZ-FIX-N2 取代：換案'
 WHERE id = 'f0000000-0000-4000-8000-00000000a007';

CREATE TEMP TABLE _r (seq int, item text, ok boolean) ON COMMIT DROP;
DO $$
DECLARE
  t constant uuid := 'f0000000-0000-4000-8000-0000000000e1';
  e constant uuid := 'f0000000-0000-4000-8000-0000000000e2';
  res jsonb;
BEGIN
  -- 擋刪：B（已驗收）、E（已付款）、C（代扣）、D（請款）都回 blocked，專案與副委託不動
  res := public.soft_delete_project(t, 'f0000000-0000-4000-8000-00000000a002', e);
  INSERT INTO _r VALUES (1, '副委託期款已驗收 → blocked paid_subcontract_payments',
    res ->> 'status' = 'blocked' AND res -> 'blockers' @> '[{"key":"paid_subcontract_payments","count":1}]'
    AND (SELECT deleted_at IS NULL FROM public.projects WHERE id = 'f0000000-0000-4000-8000-00000000a002')
    AND (SELECT deleted_at IS NULL FROM public.project_subcontracts WHERE id = 'f0000000-0000-4000-8000-00000000d002'));
  res := public.soft_delete_project(t, 'f0000000-0000-4000-8000-00000000a00b', e);
  INSERT INTO _r VALUES (2, '副委託期款已付款 → blocked paid_subcontract_payments',
    res ->> 'status' = 'blocked' AND res -> 'blockers' @> '[{"key":"paid_subcontract_payments"}]');
  res := public.soft_delete_project(t, 'f0000000-0000-4000-8000-00000000a003', e);
  INSERT INTO _r VALUES (3, '事務所已代扣 → blocked withheld_subcontracts',
    res ->> 'status' = 'blocked' AND res -> 'blockers' @> '[{"key":"withheld_subcontracts","count":1}]'
    AND (SELECT deleted_at IS NULL FROM public.projects WHERE id = 'f0000000-0000-4000-8000-00000000a003'));
  res := public.soft_delete_project(t, 'f0000000-0000-4000-8000-00000000a004', e);
  INSERT INTO _r VALUES (4, '期程已請款 → blocked billing_activity',
    res ->> 'status' = 'blocked' AND res -> 'blockers' @> '[{"key":"billing_activity","count":1}]');

  -- A：成功，連帶軟刪除 1/1/1
  res := public.soft_delete_project(t, 'f0000000-0000-4000-8000-00000000a001', e);
  INSERT INTO _r VALUES (5, '空殼案 → deleted，cascade 1／1／1，deleted_by 是操作者',
    res ->> 'status' = 'deleted' AND res -> 'cascade' = '{"billings":1,"contracts":1,"subcontracts":1}'::jsonb
    AND (SELECT deleted_at IS NOT NULL AND deleted_by_emp_id = e FROM public.projects WHERE id = 'f0000000-0000-4000-8000-00000000a001')
    AND (SELECT deleted_at IS NOT NULL AND deleted_by_emp_id = e FROM public.project_billings WHERE id = 'f0000000-0000-4000-8000-00000000b001')
    AND (SELECT deleted_at IS NOT NULL FROM public.contracts WHERE id = 'f0000000-0000-4000-8000-00000000c001')
    AND (SELECT deleted_at IS NOT NULL AND deleted_by = e FROM public.project_subcontracts WHERE id = 'f0000000-0000-4000-8000-00000000d001'));
  res := public.soft_delete_project(t, 'f0000000-0000-4000-8000-00000000a001', e);
  INSERT INTO _r VALUES (6, '再刪一次／別租戶 → not_found',
    res ->> 'status' = 'not_found'
    AND public.soft_delete_project('f0000000-0000-4000-8000-0000000000ff', 'f0000000-0000-4000-8000-00000000a002', e) ->> 'status' = 'not_found');

  -- 刪除後寫入子表一律 PD409
  BEGIN
    INSERT INTO public.project_billings (tenant_id, project_id, installment_no) VALUES (t, 'f0000000-0000-4000-8000-00000000a001', 2);
    INSERT INTO _r VALUES (7, '已刪除專案新增期程 → PD409', false);
  EXCEPTION WHEN SQLSTATE 'PD409' THEN INSERT INTO _r VALUES (7, '已刪除專案新增期程 → PD409', SQLERRM LIKE 'project_deleted:%');
  END;
  BEGIN
    UPDATE public.project_billings SET deleted_at = NULL WHERE id = 'f0000000-0000-4000-8000-00000000b001';
    INSERT INTO _r VALUES (8, '把已刪除專案的期程救回來（deleted_at → null）→ PD409', false);
  EXCEPTION WHEN SQLSTATE 'PD409' THEN INSERT INTO _r VALUES (8, '把已刪除專案的期程救回來（deleted_at → null）→ PD409', true);
  END;
  BEGIN
    UPDATE public.project_billings SET delete_reason = '補註記' WHERE id = 'f0000000-0000-4000-8000-00000000b001';
    INSERT INTO _r VALUES (9, '改「已軟刪除」的子列（仍是已刪除）放行', true);
  EXCEPTION WHEN SQLSTATE 'PD409' THEN INSERT INTO _r VALUES (9, '改「已軟刪除」的子列（仍是已刪除）放行', false);
  END;
  BEGIN
    INSERT INTO public.project_documents (tenant_id, project_id, file_name, storage_path) VALUES (t, 'f0000000-0000-4000-8000-00000000a001', 'x.pdf', 'x/x.pdf');
    INSERT INTO _r VALUES (10, '已刪除專案上傳文件 → PD409', false);
  EXCEPTION WHEN SQLSTATE 'PD409' THEN INSERT INTO _r VALUES (10, '已刪除專案上傳文件 → PD409', true);
  END;
  BEGIN
    INSERT INTO public.project_subcontract_payments (tenant_id, subcontract_id, installment_no) VALUES (t, 'f0000000-0000-4000-8000-00000000d001', 2);
    INSERT INTO _r VALUES (11, '已刪除專案的副委託新增期款 → PD409', false);
  EXCEPTION WHEN SQLSTATE 'PD409' THEN INSERT INTO _r VALUES (11, '已刪除專案的副委託新增期款 → PD409', true);
  END;
  BEGIN
    INSERT INTO public.projects (tenant_id, name, code, kind, parent_project_id) VALUES (t, '掛到已刪除母案', 'ZZ-FIX-A-1', 'change', 'f0000000-0000-4000-8000-00000000a001');
    INSERT INTO _r VALUES (12, '子案掛到已刪除母案 → PD409', false);
  EXCEPTION WHEN SQLSTATE 'PD409' THEN INSERT INTO _r VALUES (12, '子案掛到已刪除母案 → PD409', true);
  END;
  BEGIN
    INSERT INTO public.project_billings (tenant_id, project_id, installment_no) VALUES (t, 'f0000000-0000-4000-8000-00000000a002', 9);
    INSERT INTO public.contracts (tenant_id, project_id, doc_type, title) VALUES (t, 'f0000000-0000-4000-8000-00000000a002', 'contract', '活案合約');
    INSERT INTO _r VALUES (13, '未刪除專案照常寫入（期程／合約）', true);
  EXCEPTION WHEN OTHERS THEN INSERT INTO _r VALUES (13, '未刪除專案照常寫入（期程／合約）', false);
  END;

  -- 換案複製的新案被刪 → 原案還原
  res := public.soft_delete_project(t, 'f0000000-0000-4000-8000-00000000a006', e);
  INSERT INTO _r VALUES (14, '刪新案一 → 原案 O1 回到複製前（未封存、無原因），restored mode=restored',
    res ->> 'status' = 'deleted' AND res -> 'restored' @> '[{"code":"ZZ-FIX-O1","mode":"restored","archived":false}]'
    AND (SELECT archived_at IS NULL AND archive_reason IS NULL FROM public.projects WHERE id = 'f0000000-0000-4000-8000-00000000a005'));
  res := public.soft_delete_project(t, 'f0000000-0000-4000-8000-00000000a008', e);
  INSERT INTO _r VALUES (15, '刪新案二 → 原案 O2 回到「手動封存」與原封存日',
    res -> 'restored' @> '[{"code":"ZZ-FIX-O2","mode":"restored","archived":true}]'
    AND (SELECT archive_reason = '手動封存' AND archived_at = '2026-09-01T00:00:00Z'::timestamptz FROM public.projects WHERE id = 'f0000000-0000-4000-8000-00000000a007'));
  res := public.soft_delete_project(t, 'f0000000-0000-4000-8000-00000000a00a', e);
  INSERT INTO _r VALUES (16, '刪新案三（原案沒有快照）→ 保留封存、解除取代標記（mode=unmarked）',
    res -> 'restored' @> '[{"code":"ZZ-FIX-O3","mode":"unmarked","archived":true}]'
    AND (SELECT archived_at = '2026-10-01T00:00:00Z'::timestamptz AND archive_reason !~ '^已由 .+ 取代：' AND archive_reason LIKE '%ZZ-FIX-N3%'
           FROM public.projects WHERE id = 'f0000000-0000-4000-8000-00000000a009'));
  INSERT INTO _r VALUES (17, '刪除後序號釋放：可再建同號 ZZ-FIX-A', true);
  INSERT INTO public.projects (tenant_id, name, code) VALUES (t, '重建', 'ZZ-FIX-A');
END $$;
INSERT INTO _r
SELECT 18, 'audit_logs 記到軟刪除 UPDATE（專案與連帶期程）', count(DISTINCT table_name) = 2
  FROM public.audit_logs
 WHERE action = 'UPDATE' AND table_name IN ('projects', 'project_billings')
   AND record_id IN ('f0000000-0000-4000-8000-00000000a001', 'f0000000-0000-4000-8000-00000000b001')
   AND (old_row ->> 'deleted_at') IS NULL AND (new_row ->> 'deleted_at') IS NOT NULL;
SELECT seq, item, ok FROM _r ORDER BY seq;
ROLLBACK;
