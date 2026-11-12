-- 2026-11-12 刪除專案修正 2（migration 0097 ＝ sql/0087）套用後驗證（含 0096 的結構檢查）。ok 欄全為 true 才算通過。
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
  SELECT 6, '0097：projects.replaced_by_project_id uuid＋索引；觸發器 soft 模式只放行本句軟刪除（OLD null→NEW 非空）＋RD409；刪除先鎖子列、audit 帶 tenant、鏈改指向',
         (SELECT count(*) = 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'projects'
            AND column_name = 'replaced_by_project_id' AND data_type = 'uuid')
         AND EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'projects_tenant_replaced_by_idx')
         AND (SELECT pg_get_functiondef('public.assert_project_not_deleted()'::regprocedure) LIKE '%OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL%'
                 AND pg_get_functiondef('public.assert_project_not_deleted()'::regprocedure) LIKE '%RD409%')
         AND (SELECT pg_get_functiondef('public.soft_delete_project(uuid, uuid, uuid, text)'::regprocedure) LIKE '%ORDER BY b.id FOR UPDATE%'
                 AND pg_get_functiondef('public.soft_delete_project(uuid, uuid, uuid, text)'::regprocedure) LIKE '%repointed%'
                 AND pg_get_functiondef('public.soft_delete_project(uuid, uuid, uuid, text)'::regprocedure) LIKE '%unverified%'
                 AND pg_get_functiondef('public.soft_delete_project(uuid, uuid, uuid, text)'::regprocedure) LIKE '%l.tenant_id = p_tenant_id AND l.table_name = ''projects'' AND l.record_id = r.id AND l.action = ''UPDATE''%'),
         NULL
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

-- 2. 實測（pglite）：回一張 ok 表，最後 ROLLBACK 不留資料。
BEGIN;
INSERT INTO public.tenants (id, name, status) VALUES ('f0000000-0000-4000-8000-0000000000e1', '測試租戶刪除修正二', 'active');
INSERT INTO public.employees (id, tenant_id, name) VALUES ('f0000000-0000-4000-8000-0000000000e2', 'f0000000-0000-4000-8000-0000000000e1', '測試老闆');
INSERT INTO public.projects (id, tenant_id, name, code) VALUES
  ('f0000000-0000-4000-8000-00000000a001', 'f0000000-0000-4000-8000-0000000000e1', '空殼案', 'ZZ-F2-A'),
  ('f0000000-0000-4000-8000-00000000a002', 'f0000000-0000-4000-8000-0000000000e1', '活案', 'ZZ-F2-B'),
  ('f0000000-0000-4000-8000-00000000a003', 'f0000000-0000-4000-8000-0000000000e1', '副委託已驗收', 'ZZ-F2-C'),
  ('f0000000-0000-4000-8000-00000000a004', 'f0000000-0000-4000-8000-0000000000e1', '事務所已代扣', 'ZZ-F2-D'),
  -- 鏈：O1 → N1 → N2
  ('f0000000-0000-4000-8000-00000000a011', 'f0000000-0000-4000-8000-0000000000e1', '鏈原案', 'ZZ-F2-O1'),
  ('f0000000-0000-4000-8000-00000000a012', 'f0000000-0000-4000-8000-0000000000e1', '鏈中間案', 'ZZ-F2-N1'),
  ('f0000000-0000-4000-8000-00000000a013', 'f0000000-0000-4000-8000-0000000000e1', '鏈最新案', 'ZZ-F2-N2'),
  -- 欄位連結（replaced_by_project_id）的原案／新案
  ('f0000000-0000-4000-8000-00000000a021', 'f0000000-0000-4000-8000-0000000000e1', '欄位原案', 'ZZ-F2-O2'),
  ('f0000000-0000-4000-8000-00000000a022', 'f0000000-0000-4000-8000-0000000000e1', '欄位新案', 'ZZ-F2-N3'),
  -- 只有前綴吻合（改號後重用／手填相同字樣）
  ('f0000000-0000-4000-8000-00000000a031', 'f0000000-0000-4000-8000-0000000000e1', '前綴撞號的案', 'ZZ-F2-O4'),
  ('f0000000-0000-4000-8000-00000000a032', 'f0000000-0000-4000-8000-0000000000e1', '重用舊號的新案', 'ZZ-F2-M'),
  -- 稽核 INSERT（duplicated_from）連結的原案／新案
  ('f0000000-0000-4000-8000-00000000a041', 'f0000000-0000-4000-8000-0000000000e1', '稽核原案', 'ZZ-F2-O5'),
  ('f0000000-0000-4000-8000-00000000a042', 'f0000000-0000-4000-8000-0000000000e1', '稽核新案', 'ZZ-F2-N5');
-- 有 id 連結但沒有 UPDATE 快照（建立時就帶原因）→ unmarked
INSERT INTO public.projects (id, tenant_id, name, code, archived_at, archive_reason, replaced_by_project_id) VALUES
  ('f0000000-0000-4000-8000-00000000a051', 'f0000000-0000-4000-8000-0000000000e1', '無快照原案', 'ZZ-F2-O6',
   '2026-10-01T00:00:00Z', '已由 ZZ-F2-N6 取代：換案', 'f0000000-0000-4000-8000-00000000a052'),
  ('f0000000-0000-4000-8000-00000000a052', 'f0000000-0000-4000-8000-0000000000e1', '無快照新案', 'ZZ-F2-N6', NULL, NULL, NULL);
INSERT INTO public.project_billings (id, tenant_id, project_id, installment_no) VALUES
  ('f0000000-0000-4000-8000-00000000b001', 'f0000000-0000-4000-8000-0000000000e1', 'f0000000-0000-4000-8000-00000000a001', 1),
  ('f0000000-0000-4000-8000-00000000b002', 'f0000000-0000-4000-8000-0000000000e1', 'f0000000-0000-4000-8000-00000000a002', 1),
  ('f0000000-0000-4000-8000-00000000b003', 'f0000000-0000-4000-8000-0000000000e1', 'f0000000-0000-4000-8000-00000000a002', 2);
INSERT INTO public.contracts (id, tenant_id, project_id, doc_type, title) VALUES
  ('f0000000-0000-4000-8000-00000000c001', 'f0000000-0000-4000-8000-0000000000e1', 'f0000000-0000-4000-8000-00000000a001', 'contract', '草稿合約');
INSERT INTO public.project_subcontracts (id, tenant_id, project_id) VALUES
  ('f0000000-0000-4000-8000-00000000d001', 'f0000000-0000-4000-8000-0000000000e1', 'f0000000-0000-4000-8000-00000000a001'),
  ('f0000000-0000-4000-8000-00000000d003', 'f0000000-0000-4000-8000-0000000000e1', 'f0000000-0000-4000-8000-00000000a003');
INSERT INTO public.project_subcontract_payments (tenant_id, subcontract_id, installment_no, accepted_on) VALUES
  ('f0000000-0000-4000-8000-0000000000e1', 'f0000000-0000-4000-8000-00000000d003', 1, '2026-11-01');
INSERT INTO public.project_subcontracts (id, tenant_id, project_id, kind, withholding_date) VALUES
  ('f0000000-0000-4000-8000-00000000d004', 'f0000000-0000-4000-8000-0000000000e1', 'f0000000-0000-4000-8000-00000000a004', 'firm', '2026-11-03');
-- 模擬換案複製（project-duplicate.ts 第 6 步，新版會寫 replaced_by_project_id；舊資料只有稽核）
UPDATE public.projects SET archive_reason = '已由 ZZ-F2-N1 取代：第一次換案', archived_at = now(), replaced_by_project_id = 'f0000000-0000-4000-8000-00000000a012'
 WHERE id = 'f0000000-0000-4000-8000-00000000a011';
UPDATE public.projects SET archive_reason = '已由 ZZ-F2-N2 取代：第二次換案', archived_at = now(), replaced_by_project_id = 'f0000000-0000-4000-8000-00000000a013'
 WHERE id = 'f0000000-0000-4000-8000-00000000a012';
UPDATE public.projects SET archive_reason = '已由 ZZ-F2-N3 取代：換案', archived_at = now(), replaced_by_project_id = 'f0000000-0000-4000-8000-00000000a022'
 WHERE id = 'f0000000-0000-4000-8000-00000000a021';
UPDATE public.projects SET archive_reason = '已由 ZZ-F2-M 取代：手填的', archived_at = '2026-09-01T00:00:00Z'
 WHERE id = 'f0000000-0000-4000-8000-00000000a031';
UPDATE public.projects SET archive_reason = '已由 ZZ-F2-N5 取代：舊資料', archived_at = now()
 WHERE id = 'f0000000-0000-4000-8000-00000000a041';
INSERT INTO public.audit_logs (tenant_id, table_name, record_id, action, new_row, context) VALUES
  ('f0000000-0000-4000-8000-0000000000e1', 'projects', 'f0000000-0000-4000-8000-00000000a042', 'INSERT',
   '{"duplicated_from":"f0000000-0000-4000-8000-00000000a041","archive_original":true}', 'POST /projects/:id/duplicate');

CREATE TEMP TABLE _r (seq int, item text, ok boolean) ON COMMIT DROP;
DO $$
DECLARE
  t constant uuid := 'f0000000-0000-4000-8000-0000000000e1';
  e constant uuid := 'f0000000-0000-4000-8000-0000000000e2';
  res jsonb;
BEGIN
  res := public.soft_delete_project(t, 'f0000000-0000-4000-8000-00000000a003', e);
  INSERT INTO _r VALUES (1, '副委託期款已驗收 → blocked paid_subcontract_payments',
    res ->> 'status' = 'blocked' AND res -> 'blockers' @> '[{"key":"paid_subcontract_payments","count":1}]');
  res := public.soft_delete_project(t, 'f0000000-0000-4000-8000-00000000a004', e);
  INSERT INTO _r VALUES (2, '事務所已代扣 → blocked withheld_subcontracts',
    res ->> 'status' = 'blocked' AND res -> 'blockers' @> '[{"key":"withheld_subcontracts","count":1}]');

  res := public.soft_delete_project(t, 'f0000000-0000-4000-8000-00000000a001', e);
  INSERT INTO _r VALUES (3, '空殼案 → deleted，cascade 1／1／1',
    res ->> 'status' = 'deleted' AND res -> 'cascade' = '{"billings":1,"contracts":1,"subcontracts":1}'::jsonb);

  -- 【阻斷】競態：先讀到活列、刪除提交後才 UPDATE（列已軟刪、WHERE 仍成立）→ 必須失敗
  BEGIN
    UPDATE public.project_billings SET billed_on = '2026-11-12', billed_amount = 1000 WHERE id = 'f0000000-0000-4000-8000-00000000b001';
    INSERT INTO _r VALUES (4, '已刪專案的已刪期程寫 billed_on → PD409', false);
  EXCEPTION WHEN SQLSTATE 'PD409' THEN INSERT INTO _r VALUES (4, '已刪專案的已刪期程寫 billed_on → PD409', true);
  END;
  BEGIN
    UPDATE public.project_billings SET received_on = '2026-11-12', received_amount = 500 WHERE id = 'f0000000-0000-4000-8000-00000000b001';
    INSERT INTO _r VALUES (5, '已刪專案的已刪期程寫 received_amount → PD409', false);
  EXCEPTION WHEN SQLSTATE 'PD409' THEN INSERT INTO _r VALUES (5, '已刪專案的已刪期程寫 received_amount → PD409', true);
  END;
  BEGIN
    UPDATE public.contracts SET signed_on = '2026-11-12' WHERE id = 'f0000000-0000-4000-8000-00000000c001';
    INSERT INTO _r VALUES (6, '已刪專案的已刪合約寫簽約日 → PD409', false);
  EXCEPTION WHEN SQLSTATE 'PD409' THEN INSERT INTO _r VALUES (6, '已刪專案的已刪合約寫簽約日 → PD409', true);
  END;
  BEGIN
    UPDATE public.project_subcontracts SET invoice_no = 'ZZ00000009' WHERE id = 'f0000000-0000-4000-8000-00000000d001';
    INSERT INTO _r VALUES (7, '已刪專案的已刪副委託寫發票 → PD409', false);
  EXCEPTION WHEN SQLSTATE 'PD409' THEN INSERT INTO _r VALUES (7, '已刪專案的已刪副委託寫發票 → PD409', true);
  END;
  BEGIN
    UPDATE public.project_billings SET delete_reason = '補註記' WHERE id = 'f0000000-0000-4000-8000-00000000b001';
    INSERT INTO _r VALUES (8, '已刪專案的已刪期程只改刪除原因（非金流）→ 仍擋（專案已刪一律 PD409）', false);
  EXCEPTION WHEN SQLSTATE 'PD409' THEN INSERT INTO _r VALUES (8, '已刪專案的已刪期程只改刪除原因（非金流）→ 仍擋（專案已刪一律 PD409）', true);
  END;

  -- 活案、但期程已軟刪：金額／日期寫入 → RD409；改備註放行；軟刪除時夾帶金額 → RD409
  UPDATE public.project_billings SET deleted_at = now(), delete_reason = '期程調整' WHERE id = 'f0000000-0000-4000-8000-00000000b002';
  BEGIN
    UPDATE public.project_billings SET billed_on = '2026-11-12', billed_amount = 1000 WHERE id = 'f0000000-0000-4000-8000-00000000b002';
    INSERT INTO _r VALUES (9, '活案的已刪期程寫請款 → RD409', false);
  EXCEPTION WHEN SQLSTATE 'RD409' THEN INSERT INTO _r VALUES (9, '活案的已刪期程寫請款 → RD409', SQLERRM LIKE 'row_deleted:%');
  END;
  BEGIN
    UPDATE public.project_billings SET note = '只改備註' WHERE id = 'f0000000-0000-4000-8000-00000000b002';
    INSERT INTO _r VALUES (10, '活案的已刪期程只改備註 → 放行', true);
  EXCEPTION WHEN OTHERS THEN INSERT INTO _r VALUES (10, '活案的已刪期程只改備註 → 放行', false);
  END;
  BEGIN
    UPDATE public.project_billings SET deleted_at = now(), received_on = '2026-11-12', received_amount = 1 WHERE id = 'f0000000-0000-4000-8000-00000000b003';
    INSERT INTO _r VALUES (11, '軟刪除同一句夾帶入帳 → RD409', false);
  EXCEPTION WHEN SQLSTATE 'RD409' THEN INSERT INTO _r VALUES (11, '軟刪除同一句夾帶入帳 → RD409', true);
  END;
  BEGIN
    UPDATE public.project_billings SET billed_on = '2026-11-12', billed_amount = 1000 WHERE id = 'f0000000-0000-4000-8000-00000000b003';
    INSERT INTO _r VALUES (12, '活案活期程照常請款', true);
  EXCEPTION WHEN OTHERS THEN INSERT INTO _r VALUES (12, '活案活期程照常請款', false);
  END;

  -- 【重要】鏈 O1→N1→N2：刪 N1 → O1 改指向 N2（封存保留、仍是取代原因），不還原
  res := public.soft_delete_project(t, 'f0000000-0000-4000-8000-00000000a012', e);
  INSERT INTO _r VALUES (13, '鏈：刪中間案 N1 → 原案 O1 改由 N2 取代（mode=repointed），仍封存、replaced_by＝N2',
    res ->> 'status' = 'deleted'
    AND res -> 'restored' @> '[{"code":"ZZ-F2-O1","mode":"repointed","archived":true,"toCode":"ZZ-F2-N2"}]'
    AND (SELECT archived_at IS NOT NULL AND archive_reason = '已由 ZZ-F2-N2 取代：第一次換案'
                AND replaced_by_project_id = 'f0000000-0000-4000-8000-00000000a013'
           FROM public.projects WHERE id = 'f0000000-0000-4000-8000-00000000a011'));

  -- 欄位連結 → restored（回到複製前：未封存、無原因、replaced_by 清空）
  res := public.soft_delete_project(t, 'f0000000-0000-4000-8000-00000000a022', e);
  INSERT INTO _r VALUES (14, '欄位連結：刪新案 → 原案回到複製前（restored）、replaced_by 清空',
    res -> 'restored' @> '[{"code":"ZZ-F2-O2","mode":"restored","archived":false}]'
    AND (SELECT archived_at IS NULL AND archive_reason IS NULL AND replaced_by_project_id IS NULL
           FROM public.projects WHERE id = 'f0000000-0000-4000-8000-00000000a021'));

  -- 【重要】只有前綴吻合 → 不動、回 unverified
  res := public.soft_delete_project(t, 'f0000000-0000-4000-8000-00000000a032', e);
  INSERT INTO _r VALUES (15, '前綴吻合但 id 對不上 → 原案不動，回 unverified',
    res -> 'restored' = '[]'::jsonb AND res -> 'unverified' @> '[{"code":"ZZ-F2-O4"}]'
    AND (SELECT archive_reason = '已由 ZZ-F2-M 取代：手填的' AND archived_at = '2026-09-01T00:00:00Z'::timestamptz
           FROM public.projects WHERE id = 'f0000000-0000-4000-8000-00000000a031'));

  -- 舊資料：只有建立新案的稽核（duplicated_from）＋前綴 → restored
  res := public.soft_delete_project(t, 'f0000000-0000-4000-8000-00000000a042', e);
  INSERT INTO _r VALUES (16, '稽核 duplicated_from＋前綴 → restored',
    res -> 'restored' @> '[{"code":"ZZ-F2-O5","mode":"restored","archived":false}]' AND res -> 'unverified' = '[]'::jsonb);

  -- 有 id 連結但沒有快照 → unmarked（封存保留、解除取代標記）
  res := public.soft_delete_project(t, 'f0000000-0000-4000-8000-00000000a052', e);
  INSERT INTO _r VALUES (17, '有 id 連結、無快照 → unmarked，封存保留',
    res -> 'restored' @> '[{"code":"ZZ-F2-O6","mode":"unmarked","archived":true}]'
    AND (SELECT archive_reason !~ '^已由 .+ 取代：' AND archived_at IS NOT NULL AND replaced_by_project_id IS NULL
           FROM public.projects WHERE id = 'f0000000-0000-4000-8000-00000000a051'));

  BEGIN
    INSERT INTO public.project_billings (tenant_id, project_id, installment_no) VALUES (t, 'f0000000-0000-4000-8000-00000000a001', 2);
    INSERT INTO _r VALUES (18, '已刪除專案新增期程 → PD409', false);
  EXCEPTION WHEN SQLSTATE 'PD409' THEN INSERT INTO _r VALUES (18, '已刪除專案新增期程 → PD409', true);
  END;
END $$;
SELECT seq, item, ok FROM _r ORDER BY seq;
ROLLBACK;
