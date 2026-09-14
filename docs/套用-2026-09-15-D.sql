-- =====================================================================
-- 亞斯特 — 2026-09-15 D 批次（專案獎金季發放批次凍結快照：
-- bonus_runs／bonus_run_items 兩張新表）
-- 增量 SQL
--
-- 前提：正式庫已套到 migration 0044 + sql/0033（即
-- docs/套用-2026-09-15-C.sql 套用後的狀態）。不相依任何其他待套增量。
-- 內容：
--   [1]  migration 0045 —— 新表 bonus_run_items
--   [2]  migration 0045 —— 新表 bonus_runs
--   [3]  migration 0045 —— bonus_run_items 的 FK（run_id → bonus_runs）
--   [4]  migration 0045 —— bonus_run_items 的 FK（project_id → projects）
--   [5]  migration 0045 —— bonus_run_items 的 FK（employee_id → employees）
--   [6]  migration 0045 —— bonus_runs 的 FK（tenant_id → tenants）
--   [7]  migration 0045 —— bonus_runs 的 FK（created_by_emp_id → employees）
--   [8]  migration 0045 —— bonus_runs 的 FK（paid_by_emp_id → employees）
--   [9]  migration 0045 —— bonus_runs 的 FK（deleted_by_emp_id → employees）
--   [10] migration 0045 —— bonus_run_items 新增 unique index
--        （run_id, project_id, employee_id）
--   [11] migration 0045 —— bonus_run_items 新增 index（tenant_id, employee_id）
--   [12] migration 0045 —— bonus_run_items 新增 index（tenant_id, project_id）
--   [13] migration 0045 —— bonus_runs 新增 unique index（tenant_id, label）
--        （partial：where deleted_at is null）
--   [14] migration 0045 —— bonus_runs 新增 index（tenant_id, status）
--   [15] sql/0034 —— bonus_runs／bonus_run_items ENABLE ROW LEVEL SECURITY
--   [16] sql/0034 —— bonus_runs 掛 no_hard_delete／audit_all／set_updated_at
--   [17] sql/0034 —— bonus_run_items 掛 no_hard_delete／audit_all
--   [18] sql/0034 —— bonus_runs_status_chk（'draft'｜'paid'）
--   [19] sql/0034 —— bonus_runs_paid_requires_paid_on_chk
--        （status='paid' → paid_on not null）
--   [20] sql/0034 —— forbid_paid_bonus_mutation()：paid 批次凍結，
--        兩表皆掛 BEFORE UPDATE OR DELETE
--
-- 冪等，可重複執行：CREATE TABLE 一律 IF NOT EXISTS，FK 用 DO $$ ...
-- EXCEPTION WHEN duplicate_object 包起來（比照 migration 0030/0037、
-- docs/套用-2026-09-14-放款.sql／套用-2026-09-15-C.sql 的既有寫法），
-- CREATE INDEX 一律 IF NOT EXISTS，CHECK 一律先 DROP CONSTRAINT IF EXISTS
-- 再 ADD CONSTRAINT，trigger 一律先 DROP TRIGGER IF EXISTS 再 CREATE，
-- 函式一律 CREATE OR REPLACE。
--
-- 套用方式：Supabase SQL Editor 整段貼上即可（[1][2] 兩張新表互不相依，
-- 但都須早於 [3]～[14]（FK／index 用到兩張新表）；[3][4][5] 依附 [1][2]
-- 皆已建表；[6][7][8][9] 依附 [2]；[10][11][12] 依附 [1]；[13][14] 依附
-- [2]；[15]～[20] 依附 [1][2] 兩張新表都已存在。故整體順序不可打散）。
-- 前提函式：sql/0018 forbid_hard_delete()／is_disposable_tenant()、
-- sql/0019 audit_row()（sql/0033 起為記操作者版本）、sql/0027
-- set_updated_at() 已存在（前幾輪已套用）。
-- 驗證見 docs/驗證-2026-09-15-D.sql（SQL Editor 一次貼一條）。
-- =====================================================================

-- ─────────────────────────────────────────────────────────────────
-- [1] migration 0045 — 新表 bonus_run_items
-- ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "bonus_run_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"employee_id" uuid NOT NULL,
	"share_mode" text NOT NULL,
	"share_pct" numeric(6, 3),
	"share_amount" numeric(14, 2),
	"bonus_pool" numeric(14, 2),
	"contract_total" numeric(14, 2),
	"received_total" numeric(14, 2) DEFAULT '0' NOT NULL,
	"received_pct" numeric(7, 4) DEFAULT '0' NOT NULL,
	"entitled_cumulative" numeric(14, 2) DEFAULT '0' NOT NULL,
	"paid_before" numeric(14, 2) DEFAULT '0' NOT NULL,
	"amount" numeric(14, 2) DEFAULT '0' NOT NULL,
	"overpaid" boolean DEFAULT false NOT NULL,
	"snapshot" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);

-- ─────────────────────────────────────────────────────────────────
-- [2] migration 0045 — 新表 bonus_runs
-- ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "bonus_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"label" text NOT NULL,
	"as_of" date NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"paid_on" date,
	"totals" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"snapshot" jsonb,
	"note" text,
	"created_by_emp_id" uuid,
	"paid_by_emp_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"deleted_by_emp_id" uuid,
	"delete_reason" text
);

-- ─────────────────────────────────────────────────────────────────
-- [3] migration 0045 — bonus_run_items 的 FK（run_id → bonus_runs）
-- ─────────────────────────────────────────────────────────────────
DO $$ BEGIN
 ALTER TABLE "bonus_run_items" ADD CONSTRAINT "bonus_run_items_run_id_bonus_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."bonus_runs"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

-- ─────────────────────────────────────────────────────────────────
-- [4] migration 0045 — bonus_run_items 的 FK（project_id → projects）
-- ─────────────────────────────────────────────────────────────────
DO $$ BEGIN
 ALTER TABLE "bonus_run_items" ADD CONSTRAINT "bonus_run_items_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

-- ─────────────────────────────────────────────────────────────────
-- [5] migration 0045 — bonus_run_items 的 FK（employee_id → employees）
-- ─────────────────────────────────────────────────────────────────
DO $$ BEGIN
 ALTER TABLE "bonus_run_items" ADD CONSTRAINT "bonus_run_items_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."employees"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

-- ─────────────────────────────────────────────────────────────────
-- [6] migration 0045 — bonus_runs 的 FK（tenant_id → tenants）
-- ─────────────────────────────────────────────────────────────────
DO $$ BEGIN
 ALTER TABLE "bonus_runs" ADD CONSTRAINT "bonus_runs_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

-- ─────────────────────────────────────────────────────────────────
-- [7] migration 0045 — bonus_runs 的 FK（created_by_emp_id → employees）
-- ─────────────────────────────────────────────────────────────────
DO $$ BEGIN
 ALTER TABLE "bonus_runs" ADD CONSTRAINT "bonus_runs_created_by_emp_id_employees_id_fk" FOREIGN KEY ("created_by_emp_id") REFERENCES "public"."employees"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

-- ─────────────────────────────────────────────────────────────────
-- [8] migration 0045 — bonus_runs 的 FK（paid_by_emp_id → employees）
-- ─────────────────────────────────────────────────────────────────
DO $$ BEGIN
 ALTER TABLE "bonus_runs" ADD CONSTRAINT "bonus_runs_paid_by_emp_id_employees_id_fk" FOREIGN KEY ("paid_by_emp_id") REFERENCES "public"."employees"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

-- ─────────────────────────────────────────────────────────────────
-- [9] migration 0045 — bonus_runs 的 FK（deleted_by_emp_id → employees）
-- ─────────────────────────────────────────────────────────────────
DO $$ BEGIN
 ALTER TABLE "bonus_runs" ADD CONSTRAINT "bonus_runs_deleted_by_emp_id_employees_id_fk" FOREIGN KEY ("deleted_by_emp_id") REFERENCES "public"."employees"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

-- ─────────────────────────────────────────────────────────────────
-- [10] migration 0045 — bonus_run_items 新增 unique index
-- （run_id, project_id, employee_id）
-- ─────────────────────────────────────────────────────────────────
CREATE UNIQUE INDEX IF NOT EXISTS "bonus_run_items_run_project_employee_uq" ON "bonus_run_items" USING btree ("run_id","project_id","employee_id");

-- ─────────────────────────────────────────────────────────────────
-- [11] migration 0045 — bonus_run_items 新增 index（tenant_id, employee_id）
-- ─────────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS "bonus_run_items_tenant_employee_idx" ON "bonus_run_items" USING btree ("tenant_id","employee_id");

-- ─────────────────────────────────────────────────────────────────
-- [12] migration 0045 — bonus_run_items 新增 index（tenant_id, project_id）
-- ─────────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS "bonus_run_items_tenant_project_idx" ON "bonus_run_items" USING btree ("tenant_id","project_id");

-- ─────────────────────────────────────────────────────────────────
-- [13] migration 0045 — bonus_runs 新增 unique index（tenant_id, label）
-- （partial：where deleted_at is null）
-- ─────────────────────────────────────────────────────────────────
CREATE UNIQUE INDEX IF NOT EXISTS "bonus_runs_tenant_label_uq" ON "bonus_runs" USING btree ("tenant_id","label") WHERE "bonus_runs"."deleted_at" is null;

-- ─────────────────────────────────────────────────────────────────
-- [14] migration 0045 — bonus_runs 新增 index（tenant_id, status）
-- ─────────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS "bonus_runs_tenant_status_idx" ON "bonus_runs" USING btree ("tenant_id","status");

-- ─────────────────────────────────────────────────────────────────
-- [15] sql/0034 — bonus_runs／bonus_run_items ENABLE ROW LEVEL SECURITY
-- （不給 policy：前端不直讀，皆走 API service_role）
-- ─────────────────────────────────────────────────────────────────
ALTER TABLE public.bonus_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.bonus_run_items ENABLE ROW LEVEL SECURITY;

-- ─────────────────────────────────────────────────────────────────
-- [16] sql/0034 — bonus_runs 掛 no_hard_delete／audit_all／set_updated_at
-- ─────────────────────────────────────────────────────────────────
DROP TRIGGER IF EXISTS no_hard_delete ON public.bonus_runs;
CREATE TRIGGER no_hard_delete
  BEFORE DELETE ON public.bonus_runs
  FOR EACH ROW EXECUTE FUNCTION public.forbid_hard_delete();

DROP TRIGGER IF EXISTS audit_all ON public.bonus_runs;
CREATE TRIGGER audit_all
  AFTER INSERT OR UPDATE OR DELETE ON public.bonus_runs
  FOR EACH ROW EXECUTE FUNCTION public.audit_row();

DROP TRIGGER IF EXISTS set_updated_at ON public.bonus_runs;
CREATE TRIGGER set_updated_at
  BEFORE UPDATE ON public.bonus_runs
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ─────────────────────────────────────────────────────────────────
-- [17] sql/0034 — bonus_run_items 掛 no_hard_delete／audit_all
-- （無 updated_at 欄位，不掛 set_updated_at）
-- ─────────────────────────────────────────────────────────────────
DROP TRIGGER IF EXISTS no_hard_delete ON public.bonus_run_items;
CREATE TRIGGER no_hard_delete
  BEFORE DELETE ON public.bonus_run_items
  FOR EACH ROW EXECUTE FUNCTION public.forbid_hard_delete();

DROP TRIGGER IF EXISTS audit_all ON public.bonus_run_items;
CREATE TRIGGER audit_all
  AFTER INSERT OR UPDATE OR DELETE ON public.bonus_run_items
  FOR EACH ROW EXECUTE FUNCTION public.audit_row();

-- ─────────────────────────────────────────────────────────────────
-- [18] sql/0034 — bonus_runs_status_chk（'draft'｜'paid'）
-- ─────────────────────────────────────────────────────────────────
ALTER TABLE public.bonus_runs DROP CONSTRAINT IF EXISTS bonus_runs_status_chk;
ALTER TABLE public.bonus_runs ADD CONSTRAINT bonus_runs_status_chk
  CHECK (status IN ('draft', 'paid'));

-- ─────────────────────────────────────────────────────────────────
-- [19] sql/0034 — bonus_runs_paid_requires_paid_on_chk
-- （status='paid' → paid_on not null，同 sql/0029 disbursements_paid_chk）
-- ─────────────────────────────────────────────────────────────────
ALTER TABLE public.bonus_runs DROP CONSTRAINT IF EXISTS bonus_runs_paid_requires_paid_on_chk;
ALTER TABLE public.bonus_runs ADD CONSTRAINT bonus_runs_paid_requires_paid_on_chk
  CHECK (status <> 'paid' OR paid_on IS NOT NULL);

-- ─────────────────────────────────────────────────────────────────
-- [20] sql/0034 — forbid_paid_bonus_mutation()：paid 批次凍結，
-- 兩表皆掛 BEFORE UPDATE OR DELETE（僅 test/demo 租戶放行，理由見
-- sql/0034 檔頭與函式 COMMENT）
-- ─────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.forbid_paid_bonus_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_status text;
  v_tenant uuid;
BEGIN
  IF TG_TABLE_NAME = 'bonus_runs' THEN
    v_status := OLD.status;
    v_tenant := OLD.tenant_id;
  ELSE
    -- bonus_run_items 本身無 status，查所屬 run（比照 sql/0030 的
    -- 「SELECT 母表狀態」寫法）。
    SELECT r.status, r.tenant_id INTO v_status, v_tenant
      FROM public.bonus_runs r WHERE r.id = OLD.run_id;
  END IF;

  IF v_status IS DISTINCT FROM 'paid' THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;

  -- 同 0018/0019：僅 test/demo 租戶放行，供整合測試清理已發放的測試資料。
  IF public.is_disposable_tenant(v_tenant) THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;

  RAISE EXCEPTION
    '% 已發放（paid），不可 %——發放批次是凍結快照，不可覆蓋（見 sql/0034 檔頭）。',
    TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$;

COMMENT ON FUNCTION public.forbid_paid_bonus_mutation() IS
  'bonus_runs／bonus_run_items 一旦所屬批次 status=paid 即禁止 UPDATE/DELETE（凍結快照，歷年可累計對比不可被覆蓋）。bonus_runs 查自身 status，bonus_run_items 查所屬 run 的 status。僅 test/demo 租戶（is_disposable_tenant）放行供整合測試清理。';

DROP TRIGGER IF EXISTS forbid_paid_bonus_mutation ON public.bonus_runs;
CREATE TRIGGER forbid_paid_bonus_mutation
  BEFORE UPDATE OR DELETE ON public.bonus_runs
  FOR EACH ROW EXECUTE FUNCTION public.forbid_paid_bonus_mutation();

DROP TRIGGER IF EXISTS forbid_paid_bonus_mutation ON public.bonus_run_items;
CREATE TRIGGER forbid_paid_bonus_mutation
  BEFORE UPDATE OR DELETE ON public.bonus_run_items
  FOR EACH ROW EXECUTE FUNCTION public.forbid_paid_bonus_mutation();

-- ── 還原 ────────────────────────────────────────────────────────────
-- DROP TRIGGER IF EXISTS forbid_paid_bonus_mutation ON public.bonus_run_items;
-- DROP TRIGGER IF EXISTS forbid_paid_bonus_mutation ON public.bonus_runs;
-- DROP FUNCTION IF EXISTS public.forbid_paid_bonus_mutation();
-- ALTER TABLE public.bonus_runs DROP CONSTRAINT IF EXISTS bonus_runs_paid_requires_paid_on_chk;
-- ALTER TABLE public.bonus_runs DROP CONSTRAINT IF EXISTS bonus_runs_status_chk;
-- DROP TRIGGER IF EXISTS audit_all ON public.bonus_run_items;
-- DROP TRIGGER IF EXISTS no_hard_delete ON public.bonus_run_items;
-- DROP TRIGGER IF EXISTS set_updated_at ON public.bonus_runs;
-- DROP TRIGGER IF EXISTS audit_all ON public.bonus_runs;
-- DROP TRIGGER IF EXISTS no_hard_delete ON public.bonus_runs;
-- ALTER TABLE public.bonus_run_items DISABLE ROW LEVEL SECURITY; -- 不建議：一旦開了就該一直被擋住
-- ALTER TABLE public.bonus_runs DISABLE ROW LEVEL SECURITY; -- 同上，不建議
-- DROP INDEX IF EXISTS "bonus_runs_tenant_status_idx";
-- DROP INDEX IF EXISTS "bonus_runs_tenant_label_uq";
-- DROP INDEX IF EXISTS "bonus_run_items_tenant_project_idx";
-- DROP INDEX IF EXISTS "bonus_run_items_tenant_employee_idx";
-- DROP INDEX IF EXISTS "bonus_run_items_run_project_employee_uq";
-- ALTER TABLE "bonus_runs" DROP CONSTRAINT IF EXISTS "bonus_runs_deleted_by_emp_id_employees_id_fk";
-- ALTER TABLE "bonus_runs" DROP CONSTRAINT IF EXISTS "bonus_runs_paid_by_emp_id_employees_id_fk";
-- ALTER TABLE "bonus_runs" DROP CONSTRAINT IF EXISTS "bonus_runs_created_by_emp_id_employees_id_fk";
-- ALTER TABLE "bonus_runs" DROP CONSTRAINT IF EXISTS "bonus_runs_tenant_id_tenants_id_fk";
-- ALTER TABLE "bonus_run_items" DROP CONSTRAINT IF EXISTS "bonus_run_items_employee_id_employees_id_fk";
-- ALTER TABLE "bonus_run_items" DROP CONSTRAINT IF EXISTS "bonus_run_items_project_id_projects_id_fk";
-- ALTER TABLE "bonus_run_items" DROP CONSTRAINT IF EXISTS "bonus_run_items_run_id_bonus_runs_id_fk";
-- DROP TABLE IF EXISTS "bonus_runs";
-- DROP TABLE IF EXISTS "bonus_run_items";
-- （刪表會連資料一起丟，先確認沒人用。）
