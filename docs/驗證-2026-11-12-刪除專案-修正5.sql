-- 2026-11-12 刪除專案修正 5（migration 0100 ＝ sql/0090）套用後驗證（含 0096～0099 的結構檢查與實測）。ok 欄全為 true 才算通過。
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
  SELECT 6, '0100：兩個函式本體與 pglite 驗過的版本完全一致（md5(prosrc)）；replaced_by_project_id 欄位＋索引＋不可自指 CHECK',
         (SELECT md5(prosrc) = '569d7e294d2b536dfb0a6f91054da9f9' FROM pg_proc WHERE oid = 'public.assert_project_not_deleted()'::regprocedure)
         AND (SELECT md5(prosrc) = '288c9f535b026d7f112215511291d95c' FROM pg_proc WHERE oid = 'public.soft_delete_project(uuid, uuid, uuid, text)'::regprocedure)
         AND (SELECT count(*) = 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'projects'
                AND column_name = 'replaced_by_project_id' AND data_type = 'uuid')
         AND EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'projects_tenant_replaced_by_idx')
         AND EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'projects_replaced_by_not_self_chk' AND contype = 'c'
                       AND conrelid = 'public.projects'::regclass),
         (SELECT string_agg(proname || '=' || md5(prosrc), ' ') FROM pg_proc WHERE proname IN ('assert_project_not_deleted', 'soft_delete_project'))
  UNION ALL
  SELECT 5, '既有資料不受影響：沒有任何「活」子列掛在已刪除的專案上（期程／合約／副委託／已付已驗收期款／分攤／工時／獎金／每期分潤／獎金日期／分潤異動／文件／子案）',
         (SELECT count(*) FROM public.projects p WHERE p.deleted_at IS NOT NULL AND (
            EXISTS (SELECT 1 FROM public.project_billings b WHERE b.project_id = p.id AND b.deleted_at IS NULL)
            OR EXISTS (SELECT 1 FROM public.contracts c WHERE c.project_id = p.id AND c.deleted_at IS NULL)
            OR EXISTS (SELECT 1 FROM public.project_subcontracts s WHERE s.project_id = p.id AND s.deleted_at IS NULL)
            OR EXISTS (SELECT 1 FROM public.disbursement_allocations x WHERE x.project_id = p.id)
            OR EXISTS (SELECT 1 FROM public.attendance_sheet_days d WHERE d.project_id = p.id)
            OR EXISTS (SELECT 1 FROM public.bonus_run_items i WHERE i.project_id = p.id)
            OR EXISTS (SELECT 1 FROM public.project_documents d WHERE d.project_id = p.id)
            OR EXISTS (SELECT 1 FROM public.projects k WHERE k.parent_project_id = p.id AND k.deleted_at IS NULL)
            OR EXISTS (SELECT 1 FROM public.project_subcontract_payments sp JOIN public.project_subcontracts s ON s.id = sp.subcontract_id
                        WHERE s.project_id = p.id AND (sp.paid_on IS NOT NULL OR sp.accepted_on IS NOT NULL))
            OR EXISTS (SELECT 1 FROM public.project_billing_shares x WHERE x.project_id = p.id)
            OR EXISTS (SELECT 1 FROM public.project_billing_bonus_dates x WHERE x.project_id = p.id)
            OR EXISTS (SELECT 1 FROM public.project_share_adjustments x WHERE x.project_id = p.id))) = 0,
         (SELECT count(*) || ' 專案／' || count(*) FILTER (WHERE deleted_at IS NOT NULL) || ' 已刪除' FROM public.projects)
) t ORDER BY seq;

-- 2. 實測（pglite）：回一張 ok 表，最後 ROLLBACK 不留資料。
BEGIN;
INSERT INTO public.tenants (id, name, status) VALUES ('f0000000-0000-4000-8000-0000000000e1', '測試租戶刪除修正五', 'active');
INSERT INTO public.employees (id, tenant_id, name) VALUES ('f0000000-0000-4000-8000-0000000000e2', 'f0000000-0000-4000-8000-0000000000e1', '測試老闆');
INSERT INTO public.projects (id, tenant_id, name, code) VALUES
  -- R1 鏈 O→N1→N2，先刪 N1 再刪 N2
  ('f0000000-0000-4000-8000-00000000a001', 'f0000000-0000-4000-8000-0000000000e1', '鏈原案', 'ZZ-F3-O1'), ('f0000000-0000-4000-8000-00000000a002', 'f0000000-0000-4000-8000-0000000000e1', '鏈 N1', 'ZZ-F3-N1'), ('f0000000-0000-4000-8000-00000000a003', 'f0000000-0000-4000-8000-0000000000e1', '鏈 N2', 'ZZ-F3-N2'),
  -- R1 O 被 N1 取代後又複製成 N1'，刪 N1' 再刪 N1
  ('f0000000-0000-4000-8000-00000000a011', 'f0000000-0000-4000-8000-0000000000e1', '分叉原案', 'ZZ-F3-O2'), ('f0000000-0000-4000-8000-00000000a012', 'f0000000-0000-4000-8000-0000000000e1', '分叉 N1', 'ZZ-F3-M1'), ('f0000000-0000-4000-8000-00000000a013', 'f0000000-0000-4000-8000-0000000000e1', '分叉 N1撇', 'ZZ-F3-M1B'),
  -- 已刪除列的欄位、副委託期款
  ('f0000000-0000-4000-8000-00000000a021', 'f0000000-0000-4000-8000-0000000000e1', '活案', 'ZZ-F3-L'),
  -- 環：C1 被 C2 取代、C2 被 C1 取代（舊資料）
  ('f0000000-0000-4000-8000-00000000a031', 'f0000000-0000-4000-8000-0000000000e1', '環一', 'ZZ-F3-C1'), ('f0000000-0000-4000-8000-00000000a032', 'f0000000-0000-4000-8000-0000000000e1', '環二', 'ZZ-F3-C2'),
  -- 環（後繼關係只在稽核裡）：C3 的 replaced_by 為 NULL、稽核記「被 C4 取代」；C4 的 replaced_by＝C3
  ('f0000000-0000-4000-8000-00000000a041', 'f0000000-0000-4000-8000-0000000000e1', '環三', 'ZZ-F4-C3'), ('f0000000-0000-4000-8000-00000000a042', 'f0000000-0000-4000-8000-0000000000e1', '環四', 'ZZ-F4-C4');
-- 模擬換案複製（project-duplicate.ts 第 6 步：寫 archive_reason＋replaced_by_project_id）
UPDATE public.projects SET archive_reason = '已由 ZZ-F3-N1 取代：第一次', archived_at = now(), replaced_by_project_id = 'f0000000-0000-4000-8000-00000000a002' WHERE id = 'f0000000-0000-4000-8000-00000000a001';
UPDATE public.projects SET archive_reason = '已由 ZZ-F3-N2 取代：第二次', archived_at = now(), replaced_by_project_id = 'f0000000-0000-4000-8000-00000000a003' WHERE id = 'f0000000-0000-4000-8000-00000000a002';
UPDATE public.projects SET archive_reason = '已由 ZZ-F3-M1 取代：第一次', archived_at = now(), replaced_by_project_id = 'f0000000-0000-4000-8000-00000000a012' WHERE id = 'f0000000-0000-4000-8000-00000000a011';
UPDATE public.projects SET archive_reason = '已由 ZZ-F3-M1B 取代：又複製一次', replaced_by_project_id = 'f0000000-0000-4000-8000-00000000a013' WHERE id = 'f0000000-0000-4000-8000-00000000a011';
UPDATE public.projects SET archive_reason = '已由 ZZ-F3-C2 取代：環', archived_at = now(), replaced_by_project_id = 'f0000000-0000-4000-8000-00000000a032' WHERE id = 'f0000000-0000-4000-8000-00000000a031';
UPDATE public.projects SET archive_reason = '已由 ZZ-F3-C1 取代：環', archived_at = now(), replaced_by_project_id = 'f0000000-0000-4000-8000-00000000a031' WHERE id = 'f0000000-0000-4000-8000-00000000a032';
INSERT INTO public.project_billings (id, tenant_id, project_id, installment_no) VALUES
  ('f0000000-0000-4000-8000-00000000b021', 'f0000000-0000-4000-8000-0000000000e1', 'f0000000-0000-4000-8000-00000000a021', 1), ('f0000000-0000-4000-8000-00000000b022', 'f0000000-0000-4000-8000-0000000000e1', 'f0000000-0000-4000-8000-00000000a021', 2);
INSERT INTO public.contracts (id, tenant_id, project_id, doc_type, title) VALUES
  ('f0000000-0000-4000-8000-00000000c021', 'f0000000-0000-4000-8000-0000000000e1', 'f0000000-0000-4000-8000-00000000a021', 'contract', '要刪的合約');
INSERT INTO public.project_subcontracts (id, tenant_id, project_id) VALUES ('f0000000-0000-4000-8000-00000000d021', 'f0000000-0000-4000-8000-0000000000e1', 'f0000000-0000-4000-8000-00000000a021');
INSERT INTO public.project_subcontract_payments (id, tenant_id, subcontract_id, installment_no) VALUES
  ('f0000000-0000-4000-8000-00000000e021', 'f0000000-0000-4000-8000-0000000000e1', 'f0000000-0000-4000-8000-00000000d021', 1);
UPDATE public.project_billings SET deleted_at = now(), delete_reason = '期程調整' WHERE id = 'f0000000-0000-4000-8000-00000000b021';
UPDATE public.contracts SET deleted_at = now(), delete_reason = '作廢' WHERE id = 'f0000000-0000-4000-8000-00000000c021';
UPDATE public.project_subcontracts SET deleted_at = now(), delete_reason = '移除' WHERE id = 'f0000000-0000-4000-8000-00000000d021';

UPDATE public.projects SET archive_reason = '已由 ZZ-F4-C4 取代：環', archived_at = now() WHERE id = 'f0000000-0000-4000-8000-00000000a041';
UPDATE public.projects SET archive_reason = '已由 ZZ-F4-C3 取代：環', archived_at = now(), replaced_by_project_id = 'f0000000-0000-4000-8000-00000000a041'
 WHERE id = 'f0000000-0000-4000-8000-00000000a042';
INSERT INTO public.audit_logs (tenant_id, table_name, record_id, action, new_row, context) VALUES
  ('f0000000-0000-4000-8000-0000000000e1', 'projects', 'f0000000-0000-4000-8000-00000000a041', 'UPDATE',
   '{"archive_reason":"已由 ZZ-F4-C4 取代：環","replaced_by":"f0000000-0000-4000-8000-00000000a042"}', 'POST /projects/:id/duplicate (archive original)');

-- 作廢／草稿／已匯款放款單的分攤（0100：作廢單的分攤不擋刪）
INSERT INTO public.companies (id, tenant_id, name) VALUES ('f0000000-0000-4000-8000-0000000000c9', 'f0000000-0000-4000-8000-0000000000e1', '測試付款公司');
INSERT INTO public.projects (id, tenant_id, name, code) VALUES
  ('f0000000-0000-4000-8000-00000000a051', 'f0000000-0000-4000-8000-0000000000e1', '只有作廢單分攤', 'ZZ-F5-V'),
  ('f0000000-0000-4000-8000-00000000a052', 'f0000000-0000-4000-8000-0000000000e1', '有草稿單分攤', 'ZZ-F5-D'),
  ('f0000000-0000-4000-8000-00000000a053', 'f0000000-0000-4000-8000-0000000000e1', '有已匯款單分攤', 'ZZ-F5-P');
INSERT INTO public.project_subcontracts (id, tenant_id, project_id) VALUES
  ('f0000000-0000-4000-8000-00000000d051', 'f0000000-0000-4000-8000-0000000000e1', 'f0000000-0000-4000-8000-00000000a051');
INSERT INTO public.disbursements (id, tenant_id, disbursement_no, status, payee_kind, payee_name, paying_company_id, method, amount, paid_on, void_reason) VALUES
  ('f0000000-0000-4000-8000-00000000f051', 'f0000000-0000-4000-8000-0000000000e1', 'ZZ-D-051', 'paid', 'other', '測試收款', 'f0000000-0000-4000-8000-0000000000c9', 'transfer', 100, '2026-11-01', NULL),
  ('f0000000-0000-4000-8000-00000000f052', 'f0000000-0000-4000-8000-0000000000e1', 'ZZ-D-052', 'draft', 'other', '測試收款', 'f0000000-0000-4000-8000-0000000000c9', 'transfer', 100, NULL, NULL),
  ('f0000000-0000-4000-8000-00000000f053', 'f0000000-0000-4000-8000-0000000000e1', 'ZZ-D-053', 'paid', 'other', '測試收款', 'f0000000-0000-4000-8000-0000000000c9', 'transfer', 100, '2026-11-01', NULL);
INSERT INTO public.disbursement_allocations (tenant_id, disbursement_id, project_id, subcontract_id, amount) VALUES
  ('f0000000-0000-4000-8000-0000000000e1', 'f0000000-0000-4000-8000-00000000f051', 'f0000000-0000-4000-8000-00000000a051', 'f0000000-0000-4000-8000-00000000d051', 100),
  ('f0000000-0000-4000-8000-0000000000e1', 'f0000000-0000-4000-8000-00000000f052', 'f0000000-0000-4000-8000-00000000a052', NULL, 100),
  ('f0000000-0000-4000-8000-0000000000e1', 'f0000000-0000-4000-8000-00000000f053', 'f0000000-0000-4000-8000-00000000a053', NULL, 100);
-- 第一張作廢（已匯款 → 作廢）
UPDATE public.disbursements SET status = 'void', void_reason = '測試作廢' WHERE id = 'f0000000-0000-4000-8000-00000000f051';

CREATE TEMP TABLE _r (seq int, item text, ok boolean) ON COMMIT DROP;
DO $$
DECLARE
  t constant uuid := 'f0000000-0000-4000-8000-0000000000e1';
  e constant uuid := 'f0000000-0000-4000-8000-0000000000e2';
  res jsonb;
BEGIN
  -- R1 鏈：先刪 N1（O 改指向 N2），再刪 N2 → O 不可被設回「已由 N1 取代」；找不到合法快照 → unmarked、replaced_by 清空
  res := public.soft_delete_project(t, 'f0000000-0000-4000-8000-00000000a002', e);
  INSERT INTO _r VALUES (1, '鏈：刪 N1 → O 改由 N2 取代（repointed）',
    res -> 'restored' @> '[{"code":"ZZ-F3-O1","mode":"repointed"}]'
    AND (SELECT replaced_by_project_id = 'f0000000-0000-4000-8000-00000000a003' FROM public.projects WHERE id = 'f0000000-0000-4000-8000-00000000a001'));
  res := public.soft_delete_project(t, 'f0000000-0000-4000-8000-00000000a003', e);
  INSERT INTO _r VALUES (2, '鏈：再刪 N2 → O 不回到「已由 N1 取代」（N1 已刪），走 unmarked：解除取代、保留封存、replaced_by 清空',
    res -> 'restored' @> '[{"code":"ZZ-F3-O1","mode":"unmarked","archived":true}]'
    AND (SELECT archive_reason !~ '^已由 .+ 取代：' AND archived_at IS NOT NULL AND replaced_by_project_id IS NULL
           FROM public.projects WHERE id = 'f0000000-0000-4000-8000-00000000a001'));

  -- R1 分叉：O 被 N1 取代後又複製成 N1'；刪 N1' → O 回到「已由 N1 取代」且 replaced_by＝N1；再刪 N1 → O 回到複製前
  res := public.soft_delete_project(t, 'f0000000-0000-4000-8000-00000000a013', e);
  INSERT INTO _r VALUES (3, '分叉：刪 N1撇 → O 回到「已由 N1 取代」，replaced_by 同步指回 N1（仍封存）',
    res -> 'restored' @> '[{"code":"ZZ-F3-O2","mode":"restored","archived":true}]'
    AND (SELECT archive_reason = '已由 ZZ-F3-M1 取代：第一次' AND replaced_by_project_id = 'f0000000-0000-4000-8000-00000000a012' AND archived_at IS NOT NULL
           FROM public.projects WHERE id = 'f0000000-0000-4000-8000-00000000a011'));
  res := public.soft_delete_project(t, 'f0000000-0000-4000-8000-00000000a012', e);
  INSERT INTO _r VALUES (4, '分叉：再刪 N1 → O 回到第一次複製前（未封存、無原因、replaced_by 清空），不取「已由 N1撇」那筆快照',
    res -> 'restored' @> '[{"code":"ZZ-F3-O2","mode":"restored","archived":false}]'
    AND (SELECT archive_reason IS NULL AND archived_at IS NULL AND replaced_by_project_id IS NULL
           FROM public.projects WHERE id = 'f0000000-0000-4000-8000-00000000a011'));

  -- 6. 已刪除列（活案）：新補的欄位也擋；活列的試算重算照常
  BEGIN
    UPDATE public.project_billings SET calculated_amount = 123 WHERE id = 'f0000000-0000-4000-8000-00000000b021';
    INSERT INTO _r VALUES (5, '已刪期程改 calculated_amount → RD409', false);
  EXCEPTION WHEN SQLSTATE 'RD409' THEN INSERT INTO _r VALUES (5, '已刪期程改 calculated_amount → RD409', true);
  END;
  BEGIN
    UPDATE public.project_billings SET override_amount = 1, override_reason = 'x' WHERE id = 'f0000000-0000-4000-8000-00000000b021';
    INSERT INTO _r VALUES (6, '已刪期程改 override_amount → RD409', false);
  EXCEPTION WHEN SQLSTATE 'RD409' THEN INSERT INTO _r VALUES (6, '已刪期程改 override_amount → RD409', true);
  END;
  BEGIN
    UPDATE public.project_billings SET calculated_amount = 456, percentage = 50, planned_on = '2026-12-01' WHERE id = 'f0000000-0000-4000-8000-00000000b022';
    INSERT INTO _r VALUES (7, '活案活期程試算重算（calculated_amount／percentage／planned_on）照常', true);
  EXCEPTION WHEN OTHERS THEN INSERT INTO _r VALUES (7, '活案活期程試算重算（calculated_amount／percentage／planned_on）照常', false);
  END;
  BEGIN
    UPDATE public.contracts SET stamp_duty_amount = 10 WHERE id = 'f0000000-0000-4000-8000-00000000c021';
    INSERT INTO _r VALUES (8, '已刪合約改 stamp_duty_amount → RD409', false);
  EXCEPTION WHEN SQLSTATE 'RD409' THEN INSERT INTO _r VALUES (8, '已刪合約改 stamp_duty_amount → RD409', true);
  END;

  -- 7. 已刪副委託的期款
  BEGIN
    INSERT INTO public.project_subcontract_payments (tenant_id, subcontract_id, installment_no) VALUES (t, 'f0000000-0000-4000-8000-00000000d021', 2);
    INSERT INTO _r VALUES (9, '已刪副委託新增期款 → RD409', false);
  EXCEPTION WHEN SQLSTATE 'RD409' THEN INSERT INTO _r VALUES (9, '已刪副委託新增期款 → RD409', true);
  END;
  BEGIN
    UPDATE public.project_subcontract_payments SET paid_on = '2026-11-12', paid_amount = 100 WHERE id = 'f0000000-0000-4000-8000-00000000e021';
    INSERT INTO _r VALUES (10, '已刪副委託的期款寫付款 → RD409', false);
  EXCEPTION WHEN SQLSTATE 'RD409' THEN INSERT INTO _r VALUES (10, '已刪副委託的期款寫付款 → RD409', true);
  END;
  BEGIN
    UPDATE public.project_subcontract_payments SET accepted_on = '2026-11-12' WHERE id = 'f0000000-0000-4000-8000-00000000e021';
    INSERT INTO _r VALUES (11, '已刪副委託的期款寫驗收 → RD409', false);
  EXCEPTION WHEN SQLSTATE 'RD409' THEN INSERT INTO _r VALUES (11, '已刪副委託的期款寫驗收 → RD409', true);
  END;
  BEGIN
    UPDATE public.project_subcontract_payments SET note = '只改備註' WHERE id = 'f0000000-0000-4000-8000-00000000e021';
    INSERT INTO _r VALUES (12, '已刪副委託的期款只改備註 → 放行', true);
  EXCEPTION WHEN OTHERS THEN INSERT INTO _r VALUES (12, '已刪副委託的期款只改備註 → 放行', false);
  END;

  -- 8. 自指 CHECK、環
  BEGIN
    UPDATE public.projects SET replaced_by_project_id = id WHERE id = 'f0000000-0000-4000-8000-00000000a021';
    INSERT INTO _r VALUES (13, 'replaced_by_project_id 指回自己 → CHECK 擋', false);
  EXCEPTION WHEN check_violation THEN INSERT INTO _r VALUES (13, 'replaced_by_project_id 指回自己 → CHECK 擋', true);
  END;
  res := public.soft_delete_project(t, 'f0000000-0000-4000-8000-00000000a032', e);
  INSERT INTO _r VALUES (14, '環：刪 C2（C1⇄C2 互指）→ C1 不動、列 unverified',
    res ->> 'status' = 'deleted' AND res -> 'restored' = '[]'::jsonb AND res -> 'unverified' @> '[{"code":"ZZ-F3-C1"}]'
    AND (SELECT archive_reason = '已由 ZZ-F3-C2 取代：環' AND replaced_by_project_id = 'f0000000-0000-4000-8000-00000000a032' FROM public.projects WHERE id = 'f0000000-0000-4000-8000-00000000a031'));
  -- 7. 環偵測：後繼案從稽核找到（C3 的 replaced_by 為 NULL）→ 跳過條件比對實際後繼 id，C4 不動、列 unverified
  res := public.soft_delete_project(t, 'f0000000-0000-4000-8000-00000000a041', e);
  INSERT INTO _r VALUES (15, '環（稽核後繼）：刪 C3 → C4 不動（仍「已由 C3 取代」、replaced_by＝C3）、列 unverified',
    res ->> 'status' = 'deleted' AND res -> 'restored' = '[]'::jsonb AND res -> 'unverified' @> '[{"code":"ZZ-F4-C4"}]'
    AND (SELECT archive_reason = '已由 ZZ-F4-C3 取代：環' AND replaced_by_project_id = 'f0000000-0000-4000-8000-00000000a041'
           FROM public.projects WHERE id = 'f0000000-0000-4000-8000-00000000a042'));
  -- 0100：作廢單的分攤不擋刪（副委託也一併連帶軟刪除）；草稿／已匯款仍擋
  res := public.soft_delete_project(t, 'f0000000-0000-4000-8000-00000000a051', e);
  INSERT INTO _r VALUES (16, '只有作廢放款單的分攤 → 可刪，掛著作廢分攤的副委託一併連帶軟刪除',
    res ->> 'status' = 'deleted' AND (res -> 'cascade' ->> 'subcontracts')::int = 1
    AND (SELECT deleted_at IS NOT NULL FROM public.project_subcontracts WHERE id = 'f0000000-0000-4000-8000-00000000d051'));
  res := public.soft_delete_project(t, 'f0000000-0000-4000-8000-00000000a052', e);
  INSERT INTO _r VALUES (17, '草稿放款單的分攤 → 仍擋（disbursements）',
    res ->> 'status' = 'blocked' AND res -> 'blockers' @> '[{"key":"disbursements","count":1}]');
  res := public.soft_delete_project(t, 'f0000000-0000-4000-8000-00000000a053', e);
  INSERT INTO _r VALUES (18, '已匯款放款單的分攤 → 仍擋（disbursements）',
    res ->> 'status' = 'blocked' AND res -> 'blockers' @> '[{"key":"disbursements","count":1}]');
END $$;
SELECT seq, item, ok FROM _r ORDER BY seq;
ROLLBACK;
