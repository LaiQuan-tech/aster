-- =====================================================================
-- 亞斯特 — 2026-09-15 B 批次（放款發票欄／客戶分類／專案封存理由／
-- 假別必附憑證／假單核銷／印花稅各自貼）
-- 增量 SQL
--
-- 前提：正式庫已套到 migration 0042 + sql/0031（即
-- docs/套用-2026-09-15-A.sql 套用後的狀態）。不相依任何其他待套增量。
-- 內容：
--   [1]  migration 0043 —— clients 新增欄位 category
--   [2]  migration 0043 —— disbursements 新增欄位 payee_bank_code
--   [3]  migration 0043 —— disbursements 新增欄位 has_invoice
--   [4]  migration 0043 —— disbursements 新增欄位 invoice_no
--   [5]  migration 0043 —— leave_requests 新增欄位 settled_at
--   [6]  migration 0043 —— leave_requests 新增欄位 settled_by_emp_id
--   [7]  migration 0043 —— leave_requests 新增欄位 settled_period
--   [8]  migration 0043 —— leave_requests 新欄位的 FK
--        （settled_by_emp_id → employees）
--   [9]  migration 0043 —— leave_requests 新增 index（tenant_id, settled_period）
--   [10] migration 0043 —— leave_types 新增欄位 requires_attachment
--   [11] migration 0043 —— projects 新增欄位 archive_reason
--   [12] sql/0032 —— clients.category 合法值防呆 CHECK
--   [13] sql/0032 —— contracts.our_role 合法值放寬（新增 'both'）
--   [14] sql/0032 —— leave_types 掛 audit_all 稽核 trigger
--
-- ⚠️ clients 的 audit_all 稽核 trigger 已由 sql/0028／
-- docs/套用-2026-09-12.sql 掛上，非本批次新增，故本檔不重複宣告；
-- 驗證見 docs/驗證-2026-09-15-B.sql 第 15 條（一併確認它現在仍在）。
--
-- 冪等，可重複執行：ADD COLUMN 一律 IF NOT EXISTS，FK 用 DO $$ ...
-- EXCEPTION WHEN duplicate_object 包起來（比照 migration 0030/0037、
-- docs/套用-2026-09-14-放款.sql 的既有寫法），CREATE INDEX 一律
-- IF NOT EXISTS，CHECK 一律先 DROP CONSTRAINT IF EXISTS 再 ADD
-- CONSTRAINT，trigger 一律先 DROP TRIGGER IF EXISTS 再 CREATE。
--
-- 套用方式：Supabase SQL Editor 整段貼上即可（[1][2][3][4][10][11] 加
-- 欄位互不相依；[5][6][7] 加欄位須早於 [8]（FK 指向 [6] 剛加出的欄位）
-- 與 [9]（index 用到 [7] 剛加出的欄位）；[12] 依附 clients 既有欄位與
-- [1] 新加的 category；[13] 改既有 CHECK（sql/0022 建立的
-- contracts_our_role_chk），不依附本檔其他段；[14] 與其他段互不相依，
-- 故整體順序不可打散）。
-- 前提函式：sql/0019 audit_row() 已存在（前一輪已套用）。
-- 驗證見 docs/驗證-2026-09-15-B.sql（SQL Editor 一次貼一條）。
-- =====================================================================

-- ─────────────────────────────────────────────────────────────────
-- [1] migration 0043 — clients 新增欄位 category
-- ─────────────────────────────────────────────────────────────────
ALTER TABLE "clients" ADD COLUMN IF NOT EXISTS "category" text;

-- ─────────────────────────────────────────────────────────────────
-- [2] migration 0043 — disbursements 新增欄位 payee_bank_code
-- ─────────────────────────────────────────────────────────────────
ALTER TABLE "disbursements" ADD COLUMN IF NOT EXISTS "payee_bank_code" text;

-- ─────────────────────────────────────────────────────────────────
-- [3] migration 0043 — disbursements 新增欄位 has_invoice
-- ─────────────────────────────────────────────────────────────────
ALTER TABLE "disbursements" ADD COLUMN IF NOT EXISTS "has_invoice" boolean DEFAULT false NOT NULL;

-- ─────────────────────────────────────────────────────────────────
-- [4] migration 0043 — disbursements 新增欄位 invoice_no
-- ─────────────────────────────────────────────────────────────────
ALTER TABLE "disbursements" ADD COLUMN IF NOT EXISTS "invoice_no" text;

-- ─────────────────────────────────────────────────────────────────
-- [5] migration 0043 — leave_requests 新增欄位 settled_at
-- ─────────────────────────────────────────────────────────────────
ALTER TABLE "leave_requests" ADD COLUMN IF NOT EXISTS "settled_at" timestamp with time zone;

-- ─────────────────────────────────────────────────────────────────
-- [6] migration 0043 — leave_requests 新增欄位 settled_by_emp_id
-- ─────────────────────────────────────────────────────────────────
ALTER TABLE "leave_requests" ADD COLUMN IF NOT EXISTS "settled_by_emp_id" uuid;

-- ─────────────────────────────────────────────────────────────────
-- [7] migration 0043 — leave_requests 新增欄位 settled_period
-- ─────────────────────────────────────────────────────────────────
ALTER TABLE "leave_requests" ADD COLUMN IF NOT EXISTS "settled_period" text;

-- ─────────────────────────────────────────────────────────────────
-- [8] migration 0043 — leave_requests 新欄位的 FK（→ employees）
-- ─────────────────────────────────────────────────────────────────
DO $$ BEGIN
 ALTER TABLE "leave_requests" ADD CONSTRAINT "leave_requests_settled_by_emp_id_employees_id_fk" FOREIGN KEY ("settled_by_emp_id") REFERENCES "public"."employees"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

-- ─────────────────────────────────────────────────────────────────
-- [9] migration 0043 — leave_requests 新增 index（tenant_id, settled_period）
-- ─────────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS "leave_requests_tenant_settled_period_idx" ON "leave_requests" USING btree ("tenant_id","settled_period");

-- ─────────────────────────────────────────────────────────────────
-- [10] migration 0043 — leave_types 新增欄位 requires_attachment
-- ─────────────────────────────────────────────────────────────────
ALTER TABLE "leave_types" ADD COLUMN IF NOT EXISTS "requires_attachment" boolean DEFAULT false NOT NULL;

-- ─────────────────────────────────────────────────────────────────
-- [11] migration 0043 — projects 新增欄位 archive_reason
-- ─────────────────────────────────────────────────────────────────
ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "archive_reason" text;

-- ─────────────────────────────────────────────────────────────────
-- [12] sql/0032 — clients.category 合法值防呆 CHECK
-- ─────────────────────────────────────────────────────────────────
ALTER TABLE public.clients DROP CONSTRAINT IF EXISTS clients_category_chk;
ALTER TABLE public.clients ADD CONSTRAINT clients_category_chk
  CHECK (category IS NULL OR category IN ('architect', 'engineer', 'owner', 'gov', 'other'));

-- ─────────────────────────────────────────────────────────────────
-- [13] sql/0032 — contracts.our_role 合法值放寬（新增 'both'）
-- ─────────────────────────────────────────────────────────────────
ALTER TABLE public.contracts DROP CONSTRAINT IF EXISTS contracts_our_role_chk;
ALTER TABLE public.contracts ADD CONSTRAINT contracts_our_role_chk
  CHECK (our_role IN ('contractor', 'client', 'both'));

-- ─────────────────────────────────────────────────────────────────
-- [14] sql/0032 — leave_types 掛 audit_all 稽核 trigger
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
-- ALTER TABLE "projects" DROP COLUMN IF EXISTS archive_reason;
-- ALTER TABLE "leave_types" DROP COLUMN IF EXISTS requires_attachment;
-- DROP INDEX IF EXISTS "leave_requests_tenant_settled_period_idx";
-- ALTER TABLE "leave_requests" DROP CONSTRAINT IF EXISTS "leave_requests_settled_by_emp_id_employees_id_fk";
-- ALTER TABLE "leave_requests" DROP COLUMN IF EXISTS settled_period;
-- ALTER TABLE "leave_requests" DROP COLUMN IF EXISTS settled_by_emp_id;
-- ALTER TABLE "leave_requests" DROP COLUMN IF EXISTS settled_at;
-- ALTER TABLE "disbursements" DROP COLUMN IF EXISTS invoice_no;
-- ALTER TABLE "disbursements" DROP COLUMN IF EXISTS has_invoice;
-- ALTER TABLE "disbursements" DROP COLUMN IF EXISTS payee_bank_code;
-- ALTER TABLE "clients" DROP COLUMN IF EXISTS category;
-- （clients 的 audit_all 屬 sql/0028，不在本批次還原範圍內。）
