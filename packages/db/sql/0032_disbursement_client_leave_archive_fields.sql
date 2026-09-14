-- =====================================================================
-- 0032  放款發票欄／客戶分類／專案封存理由／假別必附憑證／假單核銷／
--       印花稅雙重身分（B 批次：六個並行 WP 的資料層前置）
--
-- 表結構與既有表新欄位由 drizzle migration 0043 建立
-- （disbursements.hasInvoice／invoiceNo／payeeBankCode、clients.category、
-- projects.archiveReason、leave_types.requiresAttachment、
-- leave_requests.settledAt／settledByEmpId＋FK／settledPeriod＋index）。
-- 本檔放 drizzle 管不了的三件事：
--   [1] clients.category 合法值 CHECK（比照 sql/0028 既有做法）。
--   [2] contracts.our_role 合法值 CHECK 放寬：既有 sql/0022 只允許
--       'contractor'／'client'，本輪印花稅「各自貼」WP 需要新增 'both'
--       （雙方互為承攬與定作，兩邊都要貼花）。純新增選項——sql/0022 的
--       CHECK 建立時即已驗證全部既有列只會是 'contractor'／'client'，
--       目前程式碼中寫入 our_role 的路徑（apps/api/src/routes/contracts.ts
--       的 OUR_ROLES、apps/web 對應的 OurRole 型別）也只收這兩個值，
--       故既有資料與既有寫入路徑都不受影響；本輪不動 apps/，'both' 要
--       等 app 層的 WP 開放輸入後才會真的寫入。
--   [3] leave_types 掛 audit_all 稽核 trigger（比照 sql/0019／0031 的
--       掛法；假別是否需要附憑證屬設定變更，值得留痕）。
--
-- ⚠️ clients 的 audit_all 稽核 trigger**已由 sql/0028 掛上**（該檔「clients：
-- 名冊，只稽核不禁刪」段），套用前查證：不是本檔新增，也不在本檔重複
-- 宣告——重複宣告雖是無害的 DROP+CREATE，但會讓人誤以為它是這批才開始
-- 稽核，掩蓋它其實從 P3（0028）就開始留痕的事實。查證方式與結果見
-- docs/驗證-2026-09-15-B.sql。
--
-- 前提：sql/0019 的 audit_row() 已存在；migration 0043 已套用（各表新
-- 欄位已存在）；sql/0022 的 contracts_our_role_chk 已存在（本檔重新定義
-- 其允許值集合，不是新建）。
-- 套用方式：Supabase SQL Editor。
-- 冪等：CHECK 一律先 DROP CONSTRAINT IF EXISTS 再 ADD CONSTRAINT，
-- trigger 一律先 DROP TRIGGER IF EXISTS 再 CREATE，可重複執行。
-- =====================================================================

-- ─────────────────────────────────────────────────────────────────
-- [1] clients.category 合法值防呆
-- ─────────────────────────────────────────────────────────────────
ALTER TABLE public.clients DROP CONSTRAINT IF EXISTS clients_category_chk;
ALTER TABLE public.clients ADD CONSTRAINT clients_category_chk
  CHECK (category IS NULL OR category IN ('architect', 'engineer', 'owner', 'gov', 'other'));

-- ─────────────────────────────────────────────────────────────────
-- [2] contracts.our_role 合法值放寬：'contractor' | 'client' | 'both'
-- （印花稅「各自貼」WP：雙重身分案件雙方都要貼花，需要能標記）
-- ─────────────────────────────────────────────────────────────────
ALTER TABLE public.contracts DROP CONSTRAINT IF EXISTS contracts_our_role_chk;
ALTER TABLE public.contracts ADD CONSTRAINT contracts_our_role_chk
  CHECK (our_role IN ('contractor', 'client', 'both'));

-- ─────────────────────────────────────────────────────────────────
-- [3] leave_types：假別是否必附憑證屬設定變更，掛稽核
-- ─────────────────────────────────────────────────────────────────
DROP TRIGGER IF EXISTS audit_all ON public.leave_types;
CREATE TRIGGER audit_all
  AFTER INSERT OR UPDATE OR DELETE ON public.leave_types
  FOR EACH ROW EXECUTE FUNCTION public.audit_row();

-- ── 還原 ────────────────────────────────────────────────────────────
-- DROP TRIGGER IF EXISTS audit_all ON public.leave_types;
-- ALTER TABLE public.contracts DROP CONSTRAINT IF EXISTS contracts_our_role_chk;
-- ALTER TABLE public.contracts ADD CONSTRAINT contracts_our_role_chk
--   CHECK (our_role IN ('contractor', 'client'));  -- 還原成 sql/0022 的舊集合
-- ALTER TABLE public.clients DROP CONSTRAINT IF EXISTS clients_category_chk;
-- （clients 的 audit_all 屬 sql/0028，不在本檔還原範圍內。）
