-- 2026-10-25 員工所屬公司（employees.company_id → companies.id）。
--   集團總覽要按公司看人事（在職人數、薪資成本）：一個租戶可以有多家公司主體（companies），
--   專案／放款早有公司歸屬，員工沒有，所以人事數字分不了公司。
--   company_id NULL＝未指派公司：集團總覽把這些人另列「未指派」，人事成本不分攤到任何公司。
--   公司被刪 → SET NULL（回到未指派），不擋刪公司。
-- 寫入一律經 API（service role；0066／0067 已收掉 HR 直連寫入，這裡不加任何寫入 policy）。
--   API 寫入前驗證公司屬於同租戶（FK 只指到 companies.id、不分租戶）。
-- 讀取 policy 不動：新欄位隨既有的列級讀取 policy 一起可讀。audit trigger 是整列 to_jsonb，新欄位自動入稽核。
-- 「只有一家公司的租戶自動指派」是資料轉換，只寫在套用檔（docs/套用-2026-10-25-員工所屬公司.sql），不在這裡。
-- 前提：已套到 0071（sql/0061）。可重跑（ADD COLUMN IF NOT EXISTS／CREATE INDEX IF NOT EXISTS）。
ALTER TABLE public.employees
  ADD COLUMN IF NOT EXISTS company_id uuid REFERENCES public.companies(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS employees_tenant_company_idx ON public.employees (tenant_id, company_id);
COMMENT ON COLUMN public.employees.company_id IS '員工所屬公司（companies.id）；NULL＝未指派，集團總覽另列、人事成本不分攤（2026-10-25）';
