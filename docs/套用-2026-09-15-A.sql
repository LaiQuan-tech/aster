-- =====================================================================
-- 亞斯特 — 2026-09-15 A 批次（帳號旗標／簽核模式／開案日期）
-- 增量 SQL
--
-- 前提：正式庫已套到 migration 0041 + sql/0030（即
-- docs/套用-2026-09-14-放款.sql 套用後，再套 sql/0030 的狀態）。不相依
-- 任何其他待套增量。
-- 內容：
--   [1]  migration 0042 —— employees 新增欄位 must_change_password
--   [2]  migration 0042 —— employees partial unique index（user_id，
--        排除 null；帳號邀請 WP：一人最多一組登入帳號）
--   [3]  migration 0042 —— approval_flows 新增欄位 mode
--   [4]  migration 0042 —— approval_steps 新增欄位 acted_by_emp_id
--   [5]  migration 0042 —— approval_steps 新欄位的 FK
--        （acted_by_emp_id → employees）
--   [6]  migration 0042 —— projects 新增欄位 opened_on
--   [7]  sql/0031 —— approval_flows.mode 合法值防呆 CHECK
--   [8]  sql/0031 —— employees 掛 audit_all 稽核 trigger
--   [9]  sql/0031 —— projects.opened_on 對既有列 backfill
--
-- 冪等，可重複執行：ADD COLUMN 一律 IF NOT EXISTS，FK 用 DO $$ ...
-- EXCEPTION WHEN duplicate_object 包起來（比照 migration 0030/0037、
-- docs/套用-2026-09-14-放款.sql 的既有寫法），CREATE INDEX 一律
-- IF NOT EXISTS，CHECK 一律先 DROP CONSTRAINT IF EXISTS 再 ADD
-- CONSTRAINT，trigger 一律先 DROP TRIGGER IF EXISTS 再 CREATE，backfill
-- 用 WHERE opened_on IS NULL 收斂（重跑不影響已有值的列，也不會覆蓋之後
-- 人工填過的值）。
--
-- 套用方式：Supabase SQL Editor 整段貼上即可（段間有相依：[1]-[4][6] 加
-- 欄位互不相依但須早於 [5]（FK 指向 [4] 剛加出的欄位）；[7] 依附 [3] 的
-- mode 欄位；[9] 依附 [6] 的 opened_on 欄位；[8] 與其他段互不相依，故
-- 整體順序不可打散）。
-- 前提函式：sql/0019 audit_row() 已存在（前一輪已套用）。
-- 驗證見 docs/驗證-2026-09-15-A.sql（SQL Editor 一次貼一條）。
-- =====================================================================

-- ─────────────────────────────────────────────────────────────────
-- [1] migration 0042 — employees 新增欄位 must_change_password
-- ─────────────────────────────────────────────────────────────────
ALTER TABLE "employees" ADD COLUMN IF NOT EXISTS "must_change_password" boolean DEFAULT false NOT NULL;

-- ─────────────────────────────────────────────────────────────────
-- [2] migration 0042 — employees partial unique index（user_id 排除 null）
-- ─────────────────────────────────────────────────────────────────
CREATE UNIQUE INDEX IF NOT EXISTS "employees_user_id_uq" ON "employees" USING btree ("user_id") WHERE "employees"."user_id" is not null;

-- ─────────────────────────────────────────────────────────────────
-- [3] migration 0042 — approval_flows 新增欄位 mode
-- ─────────────────────────────────────────────────────────────────
ALTER TABLE "approval_flows" ADD COLUMN IF NOT EXISTS "mode" text DEFAULT 'list' NOT NULL;

-- ─────────────────────────────────────────────────────────────────
-- [4] migration 0042 — approval_steps 新增欄位 acted_by_emp_id
-- ─────────────────────────────────────────────────────────────────
ALTER TABLE "approval_steps" ADD COLUMN IF NOT EXISTS "acted_by_emp_id" uuid;

-- ─────────────────────────────────────────────────────────────────
-- [5] migration 0042 — approval_steps 新欄位的 FK（→ employees）
-- ─────────────────────────────────────────────────────────────────
DO $$ BEGIN
 ALTER TABLE "approval_steps" ADD CONSTRAINT "approval_steps_acted_by_emp_id_employees_id_fk" FOREIGN KEY ("acted_by_emp_id") REFERENCES "public"."employees"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

-- ─────────────────────────────────────────────────────────────────
-- [6] migration 0042 — projects 新增欄位 opened_on
-- ─────────────────────────────────────────────────────────────────
ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "opened_on" date;

-- ─────────────────────────────────────────────────────────────────
-- [7] sql/0031 — approval_flows.mode 合法值防呆 CHECK
-- ─────────────────────────────────────────────────────────────────
ALTER TABLE public.approval_flows DROP CONSTRAINT IF EXISTS approval_flows_mode_chk;
ALTER TABLE public.approval_flows ADD CONSTRAINT approval_flows_mode_chk
  CHECK (mode IN ('manager', 'list'));

-- ─────────────────────────────────────────────────────────────────
-- [8] sql/0031 — employees 掛 audit_all 稽核 trigger
-- ─────────────────────────────────────────────────────────────────
DROP TRIGGER IF EXISTS audit_all ON public.employees;
CREATE TRIGGER audit_all
  AFTER INSERT OR UPDATE OR DELETE ON public.employees
  FOR EACH ROW EXECUTE FUNCTION public.audit_row();

-- ─────────────────────────────────────────────────────────────────
-- [9] sql/0031 — projects.opened_on 對既有列 backfill
-- ─────────────────────────────────────────────────────────────────
UPDATE public.projects
   SET opened_on = (created_at AT TIME ZONE 'Asia/Taipei')::date
 WHERE opened_on IS NULL;

-- ── 還原（不可逆部分：backfill 寫入的值無法分辨「本來就填」與「backfill
-- 填的」，還原只能整欄清空，請先確認沒有人工填過才做）────────────────
-- DROP TRIGGER IF EXISTS audit_all ON public.employees;
-- ALTER TABLE public.approval_flows DROP CONSTRAINT IF EXISTS approval_flows_mode_chk;
-- ALTER TABLE "projects" DROP COLUMN IF EXISTS opened_on;
-- ALTER TABLE "approval_steps" DROP CONSTRAINT IF EXISTS "approval_steps_acted_by_emp_id_employees_id_fk";
-- ALTER TABLE "approval_steps" DROP COLUMN IF EXISTS acted_by_emp_id;
-- ALTER TABLE "approval_flows" DROP COLUMN IF EXISTS mode;
-- DROP INDEX IF EXISTS "employees_user_id_uq";
-- ALTER TABLE "employees" DROP COLUMN IF EXISTS must_change_password;
