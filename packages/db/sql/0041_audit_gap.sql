-- =====================================================================
-- 0041  稽核缺口補掛（M18）：24 張有 tenant_id 但沒掛 audit 的表，
--       ＋ 4 張證據表補 no_hard_delete
--
-- 2026-09-22 逐表比對（計畫 §3.1.3）：專案硬約束「經手金額／證據的表一律稽核」，
-- 但 sql/0019 之後陸續新增的表有 24 張沒掛任何 audit trigger，其中高風險的
-- request_attachments（假單附件）、expense_claim_attachments（報銷憑證）、
-- company_pages（公司規章／福利頁）、project_documents（專案文件）改了沒人知道。
--
--   [A] audit_all（INSERT/UPDATE/DELETE 全記，同 sql/0019 A 段）：22 張。
--   [B] audit_mutations（只記 UPDATE/DELETE，同 sql/0019 B 段）：schedules、
--       tenant_calendar_days——高量、批次寫入的表，INSERT 全記會灌爆 audit_logs。
--   [C] no_hard_delete：announcement_versions、announcement_acknowledgements、
--       announcement_signature_sheets、company_pages——公告版本鏈與簽收是勞資
--       爭議證據（模組二第 2 條），sql/0018 只掛了 announcements 母表。
--
-- 刻意跳過（有 tenant_id 但不稽核）：attendance_sheet_snapshots（本身就是快照）、
-- notifications／rate_limits（高量、非證據）、user_preferences／personal_notes
-- （個人偏好與私人筆記）、knowledge_chunks（向量切片，母表 knowledge_documents
-- 已稽核）、audit_logs（自己）、tenants（無 tenant_id 欄）。
--
-- 前提：sql/0018 forbid_hard_delete()、sql/0019 audit_row() 已存在；
-- migration 0050 已套用（本檔不碰新表，新表的 trigger 在 sql/0040）。
-- 套用方式：Supabase SQL Editor（或 docs/套用-2026-09-23-需求補齊.sql 合併檔）。
-- 冪等：DROP TRIGGER IF EXISTS 後重建，可重複執行。
-- 驗證：
--   select c.relname from pg_class c join pg_namespace n on n.oid=c.relnamespace
--    where n.nspname='public' and c.relkind='r'
--      and exists(select 1 from pg_attribute a where a.attrelid=c.oid and a.attname='tenant_id')
--      and not exists(select 1 from pg_trigger t where t.tgrelid=c.oid and t.tgname in ('audit_all','audit_mutations'))
--    order by 1;
--   → 預期只剩上面「刻意跳過」那幾張。
-- =====================================================================

-- ── [A] 全量稽核 ──────────────────────────────────────────────────────
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    -- 高風險：附件與文件（改了沒人知道）
    'request_attachments',
    'expense_claim_attachments',
    'company_pages',
    'project_documents',
    -- 簽核與組織設定（決定誰能簽、誰是主管）
    'approval_flows',
    'departments',
    'shifts',
    -- 員工個資與履歷（My Data；W6 起員工可自改）
    'employee_profiles',
    'employee_educations',
    'employee_certifications',
    'employee_work_history',
    'employee_job_history',
    -- 稅務與保險眷屬（影響薪資扣繳）
    'income_tax_dependents',
    'nhi_dependents',
    'expense_settings',
    -- 招募（錄用與面試紀錄）
    'job_requisitions',
    'candidates',
    'interviews',
    'offers',
    -- 考核與知識庫
    'kpi_templates',
    'kpi_reviews',
    'knowledge_documents'
  ]
  LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS audit_all ON public.%I', t);
    EXECUTE format(
      'CREATE TRIGGER audit_all AFTER INSERT OR UPDATE OR DELETE ON public.%I '
      'FOR EACH ROW EXECUTE FUNCTION public.audit_row()', t);
  END LOOP;
END $$;

-- ── [B] 僅異動稽核：高量、批次寫入的表 ─────────────────────────────────
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'schedules',
    'tenant_calendar_days'
  ]
  LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS audit_mutations ON public.%I', t);
    EXECUTE format(
      'CREATE TRIGGER audit_mutations AFTER UPDATE OR DELETE ON public.%I '
      'FOR EACH ROW EXECUTE FUNCTION public.audit_row()', t);
  END LOOP;
END $$;

-- ── [C] 證據表補禁刪（sql/0018 FOREACH 寫法） ──────────────────────────
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'announcement_versions',
    'announcement_acknowledgements',
    'announcement_signature_sheets',
    'company_pages'
  ]
  LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS no_hard_delete ON public.%I', t);
    EXECUTE format(
      'CREATE TRIGGER no_hard_delete BEFORE DELETE ON public.%I '
      'FOR EACH ROW EXECUTE FUNCTION public.forbid_hard_delete()', t);
  END LOOP;
END $$;

-- ── 還原 ────────────────────────────────────────────────────────────
-- DO $$ DECLARE t text; BEGIN
--   FOREACH t IN ARRAY ARRAY['request_attachments','expense_claim_attachments','company_pages',
--     'project_documents','approval_flows','departments','shifts','employee_profiles',
--     'employee_educations','employee_certifications','employee_work_history','employee_job_history',
--     'income_tax_dependents','nhi_dependents','expense_settings','job_requisitions','candidates',
--     'interviews','offers','kpi_templates','kpi_reviews','knowledge_documents']
--   LOOP EXECUTE format('DROP TRIGGER IF EXISTS audit_all ON public.%I', t); END LOOP;
--   FOREACH t IN ARRAY ARRAY['schedules','tenant_calendar_days']
--   LOOP EXECUTE format('DROP TRIGGER IF EXISTS audit_mutations ON public.%I', t); END LOOP;
--   FOREACH t IN ARRAY ARRAY['announcement_versions','announcement_acknowledgements',
--     'announcement_signature_sheets','company_pages']
--   LOOP EXECUTE format('DROP TRIGGER IF EXISTS no_hard_delete ON public.%I', t); END LOOP;
-- END $$;
