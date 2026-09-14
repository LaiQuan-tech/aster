-- =====================================================================
-- 0028  clients / companies / project_subcontracts /
--       project_subcontract_payments：RLS + 禁刪與稽核 + 合法值防呆
--       （亞斯特 P3 專案申請單／客戶／副委託／期款開票入帳）
--
-- 表結構與既有表新欄位由 drizzle migration 0040 建立。本檔放 drizzle
-- 管不了的兩件事，比照 sql/0022（contracts 禁刪＋稽核＋CHECK）、
-- sql/0023（project_billings 禁刪＋稽核＋CHECK）、sql/0024（RLS）的
-- 既有做法。
--
-- ── RLS：比照 0024，四張新表 ENABLE 但不給 policy ─────────────────────
-- 前端從不直接讀表，所有讀寫都經 API 的 service_role（bypass RLS）。
--
-- ── 禁刪與稽核的取捨 ────────────────────────────────────────────────
--   • project_subcontracts / project_subcontract_payments —— 經手金額的表
--     （下包/技師費金額、期款、扣繳），比照 project_billings：
--     no_hard_delete + audit_all（全量）。
--   • clients / companies —— 名冊性質（比照 vendors：只稽核、不禁刪，
--     名冊寫錯本來就該能直接改回正確值；但異動仍留痕，因為 clientId／
--     companyId 一旦被合約/請款引用，改了名字或統編會影響歷史文件的
--     解讀，稽核讓這件事至少留得下痕跡）。
--   • project_billings 既有 trigger（sql/0023 已掛）不動，本檔只加
--     新的 CHECK。
--
-- 前提：sql/0018 的 forbid_hard_delete() 與 sql/0019 的 audit_row() 已存在。
-- 套用方式：Supabase SQL Editor。
-- 冪等：DROP IF EXISTS + CREATE，可重複執行。
-- =====================================================================

-- ── RLS ────────────────────────────────────────────────────────────
ALTER TABLE public.clients ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.companies ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.project_subcontracts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.project_subcontract_payments ENABLE ROW LEVEL SECURITY;

-- ── project_subcontracts：金額表，禁刪＋稽核 ───────────────────────────
DROP TRIGGER IF EXISTS no_hard_delete ON public.project_subcontracts;
CREATE TRIGGER no_hard_delete
  BEFORE DELETE ON public.project_subcontracts
  FOR EACH ROW EXECUTE FUNCTION public.forbid_hard_delete();

DROP TRIGGER IF EXISTS audit_all ON public.project_subcontracts;
CREATE TRIGGER audit_all
  AFTER INSERT OR UPDATE OR DELETE ON public.project_subcontracts
  FOR EACH ROW EXECUTE FUNCTION public.audit_row();

-- ── project_subcontract_payments：金額表，禁刪＋稽核 ───────────────────
DROP TRIGGER IF EXISTS no_hard_delete ON public.project_subcontract_payments;
CREATE TRIGGER no_hard_delete
  BEFORE DELETE ON public.project_subcontract_payments
  FOR EACH ROW EXECUTE FUNCTION public.forbid_hard_delete();

DROP TRIGGER IF EXISTS audit_all ON public.project_subcontract_payments;
CREATE TRIGGER audit_all
  AFTER INSERT OR UPDATE OR DELETE ON public.project_subcontract_payments
  FOR EACH ROW EXECUTE FUNCTION public.audit_row();

-- ── clients：名冊，只稽核不禁刪 ─────────────────────────────────────
DROP TRIGGER IF EXISTS audit_all ON public.clients;
CREATE TRIGGER audit_all
  AFTER INSERT OR UPDATE OR DELETE ON public.clients
  FOR EACH ROW EXECUTE FUNCTION public.audit_row();

-- ── companies：名冊，只稽核不禁刪 ───────────────────────────────────
DROP TRIGGER IF EXISTS audit_all ON public.companies;
CREATE TRIGGER audit_all
  AFTER INSERT OR UPDATE OR DELETE ON public.companies
  FOR EACH ROW EXECUTE FUNCTION public.audit_row();

-- ── 合法值防呆 ──────────────────────────────────────────────────────
ALTER TABLE public.clients DROP CONSTRAINT IF EXISTS clients_invoice_type_chk;
ALTER TABLE public.clients ADD CONSTRAINT clients_invoice_type_chk
  CHECK (invoice_type IS NULL OR invoice_type IN ('duplicate', 'triplicate'));

ALTER TABLE public.clients DROP CONSTRAINT IF EXISTS clients_payment_method_chk;
ALTER TABLE public.clients ADD CONSTRAINT clients_payment_method_chk
  CHECK (payment_method IS NULL OR payment_method IN ('transfer', 'check'));

-- 案型集合刻意寫死不做成設定表，同 projects_status_chk（sql/0021）的理由：
-- 一旦可自訂，請款/編號規則的 gating 要跟著可設定，不在 P3 範圍。
ALTER TABLE public.projects DROP CONSTRAINT IF EXISTS projects_kind_chk;
ALTER TABLE public.projects ADD CONSTRAINT projects_kind_chk
  CHECK (kind IN ('main', 'change', 'addition', 'advance'));

ALTER TABLE public.project_billings DROP CONSTRAINT IF EXISTS project_billings_kind_chk;
ALTER TABLE public.project_billings ADD CONSTRAINT project_billings_kind_chk
  CHECK (kind IN ('installment', 'guild_advance'));

-- 收款事件：received_on 有值而 received_amount 為空，對帳時會變成一筆
-- 看不見金額的實收（同 sql/0023 project_billings_billed_chk 的理由）。
ALTER TABLE public.project_billings DROP CONSTRAINT IF EXISTS project_billings_received_chk;
ALTER TABLE public.project_billings ADD CONSTRAINT project_billings_received_chk
  CHECK (received_on IS NULL OR received_amount IS NOT NULL);

ALTER TABLE public.project_subcontracts DROP CONSTRAINT IF EXISTS project_subcontracts_kind_chk;
ALTER TABLE public.project_subcontracts ADD CONSTRAINT project_subcontracts_kind_chk
  CHECK (kind IN ('subcontract', 'technician'));

ALTER TABLE public.project_subcontracts
  DROP CONSTRAINT IF EXISTS project_subcontracts_order_type_chk;
ALTER TABLE public.project_subcontracts ADD CONSTRAINT project_subcontracts_order_type_chk
  CHECK (order_type IS NULL OR order_type IN ('quotation', 'contract'));

-- 人工覆寫必須有理由（同 sql/0023 project_billings_override_chk 的理由）。
ALTER TABLE public.project_subcontract_payments
  DROP CONSTRAINT IF EXISTS project_subcontract_payments_override_chk;
ALTER TABLE public.project_subcontract_payments
  ADD CONSTRAINT project_subcontract_payments_override_chk
  CHECK (override_amount IS NULL OR override_reason IS NOT NULL);

-- 已付款就必須有金額（同上，paid_on 有值而 paid_amount 為空會對不上帳）。
ALTER TABLE public.project_subcontract_payments
  DROP CONSTRAINT IF EXISTS project_subcontract_payments_paid_chk;
ALTER TABLE public.project_subcontract_payments
  ADD CONSTRAINT project_subcontract_payments_paid_chk
  CHECK (paid_on IS NULL OR paid_amount IS NOT NULL);

ALTER TABLE public.project_settings
  DROP CONSTRAINT IF EXISTS project_settings_code_year_style_chk;
ALTER TABLE public.project_settings ADD CONSTRAINT project_settings_code_year_style_chk
  CHECK (code_year_style IN ('roc', 'ad'));

-- ── 還原 ────────────────────────────────────────────────────────────
-- DROP TRIGGER IF EXISTS no_hard_delete ON public.project_subcontracts;
-- DROP TRIGGER IF EXISTS audit_all      ON public.project_subcontracts;
-- DROP TRIGGER IF EXISTS no_hard_delete ON public.project_subcontract_payments;
-- DROP TRIGGER IF EXISTS audit_all      ON public.project_subcontract_payments;
-- DROP TRIGGER IF EXISTS audit_all      ON public.clients;
-- DROP TRIGGER IF EXISTS audit_all      ON public.companies;
-- ALTER TABLE public.clients DROP CONSTRAINT IF EXISTS clients_invoice_type_chk;
-- ALTER TABLE public.clients DROP CONSTRAINT IF EXISTS clients_payment_method_chk;
-- ALTER TABLE public.projects DROP CONSTRAINT IF EXISTS projects_kind_chk;
-- ALTER TABLE public.project_billings DROP CONSTRAINT IF EXISTS project_billings_kind_chk;
-- ALTER TABLE public.project_billings DROP CONSTRAINT IF EXISTS project_billings_received_chk;
-- ALTER TABLE public.project_subcontracts DROP CONSTRAINT IF EXISTS project_subcontracts_kind_chk;
-- ALTER TABLE public.project_subcontracts DROP CONSTRAINT IF EXISTS project_subcontracts_order_type_chk;
-- ALTER TABLE public.project_subcontract_payments DROP CONSTRAINT IF EXISTS project_subcontract_payments_override_chk;
-- ALTER TABLE public.project_subcontract_payments DROP CONSTRAINT IF EXISTS project_subcontract_payments_paid_chk;
-- ALTER TABLE public.project_settings DROP CONSTRAINT IF EXISTS project_settings_code_year_style_chk;
-- （不 DISABLE RLS：一旦開了 anon/authenticated 就該一直被擋住。）
