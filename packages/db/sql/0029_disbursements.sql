-- =====================================================================
-- 0029  disbursements / disbursement_allocations / disbursement_attachments：
--       RLS + 禁刪與稽核 + updated_at 自動更新 + 合法值防呆 + storage bucket
--       （放款專區 P1：匯款紀錄 × 專案連動）
--
-- 表結構由 drizzle migration 0041 建立（新表三張；vendors 加收款帳戶四欄；
-- project_subcontract_payments 加 disbursement_id）。本檔放 drizzle 管不了
-- 的四件事，比照 sql/0027（attendance_sheets 禁刪＋稽核＋updated_at＋CHECK）、
-- sql/0028（新表 RLS＋禁刪／稽核取捨＋CHECK）、sql/0020（storage bucket）
-- 的既有做法。
--
-- ── RLS：比照 0024/0027/0028，三張新表 ENABLE 但不給 policy ────────────
-- 前端從不直接讀表，所有讀寫都經 API 的 service_role（bypass RLS）。
--
-- ── 禁刪與稽核的取捨（同 sql/0028 的判準）───────────────────────────
--   • disbursements —— 放款的單一真相，經手金額：no_hard_delete + audit_all
--     （全量）+ set_updated_at（sql/0027 引入的通用函式，此表比照使用）。
--   • disbursement_allocations —— 分攤金額表，同上 no_hard_delete +
--     audit_all；無 updated_at 欄位（見 drizzle schema 註解：分攤列建立後
--     不就地改，draft 的 PATCH 是整批覆蓋），故不掛 set_updated_at。
--   • disbursement_attachments —— 沿用 project_documents 的模式（附件可由
--     使用者刪除重傳，見計畫 API 段 DELETE /:aid），只掛 audit_all，
--     不禁刪。
--
-- 前提：sql/0018 的 forbid_hard_delete()、sql/0019 的 audit_row()、
-- sql/0027 的 set_updated_at() 已存在。
-- 套用方式：Supabase SQL Editor。
-- 冪等：DROP IF EXISTS + CREATE / ON CONFLICT DO NOTHING，可重複執行。
-- =====================================================================

-- ── RLS ────────────────────────────────────────────────────────────
ALTER TABLE public.disbursements ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.disbursement_allocations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.disbursement_attachments ENABLE ROW LEVEL SECURITY;

-- ── disbursements：金額表，禁刪＋稽核＋updated_at ───────────────────────
DROP TRIGGER IF EXISTS no_hard_delete ON public.disbursements;
CREATE TRIGGER no_hard_delete
  BEFORE DELETE ON public.disbursements
  FOR EACH ROW EXECUTE FUNCTION public.forbid_hard_delete();

DROP TRIGGER IF EXISTS audit_all ON public.disbursements;
CREATE TRIGGER audit_all
  AFTER INSERT OR UPDATE OR DELETE ON public.disbursements
  FOR EACH ROW EXECUTE FUNCTION public.audit_row();

DROP TRIGGER IF EXISTS set_updated_at ON public.disbursements;
CREATE TRIGGER set_updated_at
  BEFORE UPDATE ON public.disbursements
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ── disbursement_allocations：金額表，禁刪＋稽核（無 updated_at 欄位）──
DROP TRIGGER IF EXISTS no_hard_delete ON public.disbursement_allocations;
CREATE TRIGGER no_hard_delete
  BEFORE DELETE ON public.disbursement_allocations
  FOR EACH ROW EXECUTE FUNCTION public.forbid_hard_delete();

DROP TRIGGER IF EXISTS audit_all ON public.disbursement_allocations;
CREATE TRIGGER audit_all
  AFTER INSERT OR UPDATE OR DELETE ON public.disbursement_allocations
  FOR EACH ROW EXECUTE FUNCTION public.audit_row();

-- ── disbursement_attachments：只稽核，不禁刪（附件可刪除重傳） ─────────
DROP TRIGGER IF EXISTS audit_all ON public.disbursement_attachments;
CREATE TRIGGER audit_all
  AFTER INSERT OR UPDATE OR DELETE ON public.disbursement_attachments
  FOR EACH ROW EXECUTE FUNCTION public.audit_row();

-- ── 合法值防呆 ──────────────────────────────────────────────────────
ALTER TABLE public.disbursements DROP CONSTRAINT IF EXISTS disbursements_status_chk;
ALTER TABLE public.disbursements ADD CONSTRAINT disbursements_status_chk
  CHECK (status IN ('draft', 'paid', 'void'));

-- 已匯款就必須有匯款日（同 sql/0023 project_billings_billed_chk 的理由）。
ALTER TABLE public.disbursements DROP CONSTRAINT IF EXISTS disbursements_paid_chk;
ALTER TABLE public.disbursements ADD CONSTRAINT disbursements_paid_chk
  CHECK (status <> 'paid' OR paid_on IS NOT NULL);

-- 作廢必須留理由，反查時才知道為什麼這筆錢不算數。
ALTER TABLE public.disbursements DROP CONSTRAINT IF EXISTS disbursements_void_chk;
ALTER TABLE public.disbursements ADD CONSTRAINT disbursements_void_chk
  CHECK (status <> 'void' OR void_reason IS NOT NULL);

ALTER TABLE public.disbursements DROP CONSTRAINT IF EXISTS disbursements_amount_chk;
ALTER TABLE public.disbursements ADD CONSTRAINT disbursements_amount_chk
  CHECK (amount >= 0 AND withheld_amount >= 0);

-- 收款方選了「廠商」就必須指到 vendors 名冊（「其他」才是自由文字）。
ALTER TABLE public.disbursements DROP CONSTRAINT IF EXISTS disbursements_payee_chk;
ALTER TABLE public.disbursements ADD CONSTRAINT disbursements_payee_chk
  CHECK (payee_kind <> 'vendor' OR vendor_id IS NOT NULL);

ALTER TABLE public.disbursements DROP CONSTRAINT IF EXISTS disbursements_method_chk;
ALTER TABLE public.disbursements ADD CONSTRAINT disbursements_method_chk
  CHECK (method IN ('transfer', 'check', 'cash'));

ALTER TABLE public.disbursement_allocations
  DROP CONSTRAINT IF EXISTS disbursement_allocations_amount_chk;
ALTER TABLE public.disbursement_allocations
  ADD CONSTRAINT disbursement_allocations_amount_chk
  CHECK (amount > 0);

-- =====================================================================
-- storage bucket：disbursement-vouchers（匯款單截圖／收據，比照 sql/0020）
--
-- private（public = false）：匯款憑證是金流證據，不可公開讀取。API 以
-- service_role 上傳，讀取一律走短效期 signed URL（見計畫 §三 GET /:id
-- 的 3600s）。RLS：storage.objects 預設啟用且無 policy＝一律拒絕，
-- service_role 繞過 RLS，前端 anon key 讀不到——不要為了「方便」加
-- anon 可讀的 policy。
-- =====================================================================
insert into storage.buckets (id, name, public)
values ('disbursement-vouchers', 'disbursement-vouchers', false)
on conflict (id) do nothing;

update storage.buckets
   set public = false
 where id = 'disbursement-vouchers'
   and public is distinct from false;

-- ── 還原（不可逆部分：新表刪除會連資料一起丟，先確認沒人用）────────────
-- delete from storage.objects where bucket_id = 'disbursement-vouchers';
-- delete from storage.buckets where id = 'disbursement-vouchers';
-- ALTER TABLE public.disbursement_allocations DROP CONSTRAINT IF EXISTS disbursement_allocations_amount_chk;
-- ALTER TABLE public.disbursements DROP CONSTRAINT IF EXISTS disbursements_method_chk;
-- ALTER TABLE public.disbursements DROP CONSTRAINT IF EXISTS disbursements_payee_chk;
-- ALTER TABLE public.disbursements DROP CONSTRAINT IF EXISTS disbursements_amount_chk;
-- ALTER TABLE public.disbursements DROP CONSTRAINT IF EXISTS disbursements_void_chk;
-- ALTER TABLE public.disbursements DROP CONSTRAINT IF EXISTS disbursements_paid_chk;
-- ALTER TABLE public.disbursements DROP CONSTRAINT IF EXISTS disbursements_status_chk;
-- DROP TRIGGER IF EXISTS audit_all ON public.disbursement_attachments;
-- DROP TRIGGER IF EXISTS audit_all ON public.disbursement_allocations;
-- DROP TRIGGER IF EXISTS no_hard_delete ON public.disbursement_allocations;
-- DROP TRIGGER IF EXISTS set_updated_at ON public.disbursements;
-- DROP TRIGGER IF EXISTS audit_all ON public.disbursements;
-- DROP TRIGGER IF EXISTS no_hard_delete ON public.disbursements;
-- ALTER TABLE "project_subcontract_payments" DROP COLUMN IF EXISTS disbursement_id;
-- ALTER TABLE "vendors" DROP COLUMN IF EXISTS bank_name, DROP COLUMN IF EXISTS bank_code, DROP COLUMN IF EXISTS bank_account, DROP COLUMN IF EXISTS account_holder;
-- DROP TABLE IF EXISTS public.disbursement_attachments;
-- DROP TABLE IF EXISTS public.disbursement_allocations;
-- DROP TABLE IF EXISTS public.disbursements;
-- （不 DISABLE RLS：一旦開了 anon/authenticated 就該一直被擋住。）
