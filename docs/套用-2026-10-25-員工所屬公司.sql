-- =====================================================================
-- 2026-10-25 員工所屬公司（migration 0072 ＝ sql/0062）
--
-- 前提：已套到 0071（sql/0061，docs/套用-2026-10-17-國定假日匯入草稿.sql）。整份可重跑（冪等）。
-- 套用後跑 docs/驗證-2026-10-25-員工所屬公司.sql。
-- 順序：先套本檔、再部署 API 與網頁皆可。API 先探測欄位（lib/schema-compat employeesHaveCompany）：
--   沒套時員工清單／GET /me 的 companyId、companyName 一律 null，集團總覽的人數與薪資全部列在「未指派」；
--   寫入（PATCH /employees 帶 companyId、POST /employees/assign-company）回 409 schema_not_ready。
-- 用途：集團總覽按公司看在職人數、薪資成本，以及「毛利扣人事成本後」。company_id NULL＝未指派公司，
--   總覽另列「未指派」、人事成本不分攤到任何公司。
-- =====================================================================

-- ── 1. 欄位與索引（＝ migration 0072）────────────────────────────────
-- 寫入一律經 API（service role）；0066／0067 已收掉 HR 直連寫入，這裡不加任何寫入 policy。
-- 讀取 policy 不動；audit trigger 整列 to_jsonb，新欄位自動入稽核。公司被刪 → SET NULL（回到未指派）。
ALTER TABLE public.employees
  ADD COLUMN IF NOT EXISTS company_id uuid REFERENCES public.companies(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS employees_tenant_company_idx ON public.employees (tenant_id, company_id);
COMMENT ON COLUMN public.employees.company_id IS '員工所屬公司（companies.id）；NULL＝未指派，集團總覽另列、人事成本不分攤（2026-10-25）';

-- ── 2. 只有一家公司的租戶：員工自動指派為該公司（資料轉換，可選）──────────────
-- 條件：該租戶 companies 恰好 1 筆（含停用的也算一筆），而且員工的 company_id 還是 NULL。
-- 有兩家以上公司的租戶一律不動（要由 HR 在後台員工頁逐一或批次指派）；已指派的員工不動，重跑不會覆蓋。
-- 不想自動指派（例如打算之後才建第二家公司、想讓全部人先列在未指派）→ 整段不要執行即可，第 1 段可單獨套。
-- 會寫 audit_logs（每位被指派的員工一筆 UPDATE）。
UPDATE public.employees e
   SET company_id = c.id
  FROM public.companies c
 WHERE c.tenant_id = e.tenant_id
   AND e.company_id IS NULL
   AND (SELECT count(*) FROM public.companies c2 WHERE c2.tenant_id = e.tenant_id) = 1;

-- ── 還原 ────────────────────────────────────────────────────────────
-- 先部署回不讀這個欄位的 API（或確認已部署的 API 會探測欄位），再：
-- DROP INDEX IF EXISTS public.employees_tenant_company_idx;
-- ALTER TABLE public.employees DROP COLUMN IF EXISTS company_id;
