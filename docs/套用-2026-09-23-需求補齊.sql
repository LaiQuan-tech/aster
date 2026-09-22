-- =====================================================================
-- 亞斯特 — 2026-09-23 需求補齊（對照客戶 0807／0914 會議記錄）
-- 增量 SQL（合併檔：migration 0050 ＋ sql/0040 ＋ sql/0041）
--
-- 前提：正式庫已套到 migration 0049 + sql/0039（即 2026-09-22 晚
-- docs/套用-2026-09-22-多級簽核.sql 套用後的狀態）。不相依任何其他待套增量。
-- 內容：
--   [0]  migration 0050 —— 六張新表（overtime_settlements 加班超額另計、
--        festival_bonuses 三節獎金、birthday_gifts 生日紅包、duty_rosters 值日／總機、
--        employee_profile_change_requests 員工改資料審核、disbursement_approval_steps
--        放款簽核關卡）＋ 既有表加欄：leave_balances.period_start／period_end／source／note
--        （唯一鍵換成 (tenant, emp, type, period_start)）、leave_requests.beyond_cap／
--        beyond_cap_detail、disbursements 簽核五欄、project_subcontract_payments 驗收三欄、
--        project_settings.default_share_pct_by_role、payslips.sent_at／sent_to
--   [1]  sql/0040 —— 新表 RLS／禁刪／稽核／CHECK、forbid_paid_row_mutation()、
--        leave_balances 曆年列 backfill 成 1/1～12/31 後 NOT NULL、disbursements_status_chk
--        加 pending_approval／approved、is_project_lead() 含 manager、projects.engineers
--        舊 key 中文化、bucket birthday-photos、COMMENT
--   [2]  sql/0041 —— 24 張表補 audit（22 張 audit_all＋schedules／tenant_calendar_days
--        audit_mutations）、4 張證據表補 no_hard_delete
--
-- 為什麼要：業主 2026-09-22 拿客戶會議記錄比對後拍板四項決策（C 單合法替代版＝
-- 月加班上限＋超額另行給付；40 小時可調；會計角色；歷史版本檢視），本檔是這批
-- 需求的資料模型基礎（計畫 §3.1），API／web 的 WP1–WP9 都從這裡接。
--
-- 順序：先套本檔（DB），再部署 API／web／worker。既有 API 對新欄位一律不讀不寫，
-- 先部署新 API 才會用到；leave_balances 唯一鍵改用 period_start 後，舊 API 的
-- PUT /leave-balances（以 year upsert）在套用後、新 API 部署前這段空窗會因為
-- period_start NOT NULL 而失敗——請 DB→API 連著部署。
--
-- 冪等，可重複執行：CREATE TABLE／INDEX 一律 IF NOT EXISTS，FK 用 DO $$ … EXCEPTION
-- WHEN duplicate_object 包起來，ADD COLUMN IF NOT EXISTS，CHECK 先 DROP IF EXISTS 再 ADD，
-- trigger 先 DROP IF EXISTS 再 CREATE，函式 CREATE OR REPLACE，backfill 只碰 NULL／含舊
-- key 的列，bucket ON CONFLICT DO NOTHING，COMMENT 可重設。
-- 已用 `npm run db:replay -- --base-migration 49 --base-sql 39
--   --base-file docs/套用-2026-09-22-多級簽核.sql --seed docs/test/replay-seed-2026-09-23.sql
--   docs/套用-2026-09-23-需求補齊.sql --verify docs/驗證-2026-09-23-需求補齊.sql --compare-raw`
-- 在 pglite 上重放兩次（冪等）、驗 backfill，並與 raw 檔（migrations + sql/）比對 schema 一致。
--
-- 套用方式：Supabase SQL Editor 整段貼上即可（一個交易；任何一條失敗整檔回滾）。
-- 驗證見 docs/驗證-2026-09-23-需求補齊.sql（SQL Editor 一次貼一條）。
-- =====================================================================

-- ─────────────────────────────────────────────────────────────────
-- [0] migration 0050 — 六張新表與既有表加欄（原檔 packages/db/migrations/0050_requirements_2026_09_23.sql）
-- ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "birthday_gifts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"employee_id" uuid NOT NULL,
	"year" integer NOT NULL,
	"given_on" date,
	"amount" numeric(12, 2),
	"photo_path" text,
	"photo_file_name" text,
	"note" text,
	"created_by_emp_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE TABLE IF NOT EXISTS "disbursement_approval_steps" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"disbursement_id" uuid NOT NULL,
	"round" integer DEFAULT 1 NOT NULL,
	"step_order" integer NOT NULL,
	"approver_emp_id" uuid NOT NULL,
	"candidate_emp_ids" uuid[],
	"step_kind" text,
	"decision" text DEFAULT 'pending' NOT NULL,
	"comment" text,
	"acted_at" timestamp with time zone,
	"acted_by_emp_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE TABLE IF NOT EXISTS "duty_rosters" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"duty_type" text NOT NULL,
	"work_date" date NOT NULL,
	"employee_id" uuid NOT NULL,
	"batch_id" uuid,
	"note" text,
	"created_by_emp_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE TABLE IF NOT EXISTS "employee_profile_change_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"employee_id" uuid NOT NULL,
	"requested_by_emp_id" uuid,
	"changes" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"reviewed_by_emp_id" uuid,
	"reviewed_at" timestamp with time zone,
	"review_comment" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE TABLE IF NOT EXISTS "festival_bonuses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"employee_id" uuid NOT NULL,
	"festival" text NOT NULL,
	"year" integer NOT NULL,
	"reference_date" date,
	"suggested_amount" numeric(14, 2),
	"prorate_months" integer,
	"final_amount" numeric(14, 2),
	"status" text DEFAULT 'draft' NOT NULL,
	"paid_on" date,
	"note" text,
	"created_by_emp_id" uuid,
	"paid_by_emp_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE TABLE IF NOT EXISTS "overtime_settlements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"employee_id" uuid NOT NULL,
	"period" text NOT NULL,
	"source" text DEFAULT 'beyond_cap' NOT NULL,
	"minutes" integer DEFAULT 0 NOT NULL,
	"amount" numeric(14, 2),
	"channel" text DEFAULT 'cash' NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"paid_on" date,
	"sheet_id" uuid,
	"note" text,
	"created_by_emp_id" uuid,
	"paid_by_emp_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
DROP INDEX IF EXISTS "leave_balances_tenant_emp_type_year_uq";
ALTER TABLE "disbursements" ADD COLUMN IF NOT EXISTS "current_step" integer;
ALTER TABLE "disbursements" ADD COLUMN IF NOT EXISTS "approval_round" integer DEFAULT 0 NOT NULL;
ALTER TABLE "disbursements" ADD COLUMN IF NOT EXISTS "submitted_at" timestamp with time zone;
ALTER TABLE "disbursements" ADD COLUMN IF NOT EXISTS "submitted_by_emp_id" uuid;
ALTER TABLE "disbursements" ADD COLUMN IF NOT EXISTS "approved_at" timestamp with time zone;
ALTER TABLE "leave_balances" ADD COLUMN IF NOT EXISTS "period_start" date;
ALTER TABLE "leave_balances" ADD COLUMN IF NOT EXISTS "period_end" date;
ALTER TABLE "leave_balances" ADD COLUMN IF NOT EXISTS "source" text DEFAULT 'manual' NOT NULL;
ALTER TABLE "leave_balances" ADD COLUMN IF NOT EXISTS "note" text;
ALTER TABLE "leave_requests" ADD COLUMN IF NOT EXISTS "beyond_cap" boolean DEFAULT false NOT NULL;
ALTER TABLE "leave_requests" ADD COLUMN IF NOT EXISTS "beyond_cap_detail" jsonb;
ALTER TABLE "payslips" ADD COLUMN IF NOT EXISTS "sent_at" timestamp with time zone;
ALTER TABLE "payslips" ADD COLUMN IF NOT EXISTS "sent_to" text;
ALTER TABLE "project_settings" ADD COLUMN IF NOT EXISTS "default_share_pct_by_role" jsonb DEFAULT '{}'::jsonb NOT NULL;
ALTER TABLE "project_subcontract_payments" ADD COLUMN IF NOT EXISTS "accepted_on" date;
ALTER TABLE "project_subcontract_payments" ADD COLUMN IF NOT EXISTS "accepted_by_emp_id" uuid;
ALTER TABLE "project_subcontract_payments" ADD COLUMN IF NOT EXISTS "acceptance_note" text;
DO $$ BEGIN
 ALTER TABLE "birthday_gifts" ADD CONSTRAINT "birthday_gifts_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
DO $$ BEGIN
 ALTER TABLE "birthday_gifts" ADD CONSTRAINT "birthday_gifts_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."employees"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
DO $$ BEGIN
 ALTER TABLE "disbursement_approval_steps" ADD CONSTRAINT "disbursement_approval_steps_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
DO $$ BEGIN
 ALTER TABLE "disbursement_approval_steps" ADD CONSTRAINT "disbursement_approval_steps_disbursement_id_disbursements_id_fk" FOREIGN KEY ("disbursement_id") REFERENCES "public"."disbursements"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
DO $$ BEGIN
 ALTER TABLE "disbursement_approval_steps" ADD CONSTRAINT "disbursement_approval_steps_approver_emp_id_employees_id_fk" FOREIGN KEY ("approver_emp_id") REFERENCES "public"."employees"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
DO $$ BEGIN
 ALTER TABLE "disbursement_approval_steps" ADD CONSTRAINT "disbursement_approval_steps_acted_by_emp_id_employees_id_fk" FOREIGN KEY ("acted_by_emp_id") REFERENCES "public"."employees"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
DO $$ BEGIN
 ALTER TABLE "duty_rosters" ADD CONSTRAINT "duty_rosters_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
DO $$ BEGIN
 ALTER TABLE "duty_rosters" ADD CONSTRAINT "duty_rosters_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."employees"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
DO $$ BEGIN
 ALTER TABLE "employee_profile_change_requests" ADD CONSTRAINT "employee_profile_change_requests_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
DO $$ BEGIN
 ALTER TABLE "employee_profile_change_requests" ADD CONSTRAINT "employee_profile_change_requests_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."employees"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
DO $$ BEGIN
 ALTER TABLE "festival_bonuses" ADD CONSTRAINT "festival_bonuses_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
DO $$ BEGIN
 ALTER TABLE "festival_bonuses" ADD CONSTRAINT "festival_bonuses_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."employees"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
DO $$ BEGIN
 ALTER TABLE "overtime_settlements" ADD CONSTRAINT "overtime_settlements_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
DO $$ BEGIN
 ALTER TABLE "overtime_settlements" ADD CONSTRAINT "overtime_settlements_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."employees"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
CREATE UNIQUE INDEX IF NOT EXISTS "birthday_gifts_tenant_emp_year_uq" ON "birthday_gifts" USING btree ("tenant_id","employee_id","year");
CREATE UNIQUE INDEX IF NOT EXISTS "disbursement_approval_steps_disb_round_step_uq" ON "disbursement_approval_steps" USING btree ("disbursement_id","round","step_order");
CREATE INDEX IF NOT EXISTS "disbursement_approval_steps_tenant_disb_idx" ON "disbursement_approval_steps" USING btree ("tenant_id","disbursement_id");
CREATE UNIQUE INDEX IF NOT EXISTS "duty_rosters_tenant_type_date_uq" ON "duty_rosters" USING btree ("tenant_id","duty_type","work_date");
CREATE INDEX IF NOT EXISTS "duty_rosters_tenant_date_idx" ON "duty_rosters" USING btree ("tenant_id","work_date");
CREATE INDEX IF NOT EXISTS "employee_profile_change_requests_tenant_status_idx" ON "employee_profile_change_requests" USING btree ("tenant_id","status");
CREATE UNIQUE INDEX IF NOT EXISTS "festival_bonuses_tenant_emp_festival_year_uq" ON "festival_bonuses" USING btree ("tenant_id","employee_id","festival","year");
CREATE UNIQUE INDEX IF NOT EXISTS "overtime_settlements_beyond_cap_uq" ON "overtime_settlements" USING btree ("tenant_id","employee_id","period") WHERE "overtime_settlements"."source" = 'beyond_cap';
CREATE INDEX IF NOT EXISTS "overtime_settlements_tenant_period_idx" ON "overtime_settlements" USING btree ("tenant_id","period");
CREATE UNIQUE INDEX IF NOT EXISTS "leave_balances_tenant_emp_type_period_uq" ON "leave_balances" USING btree ("tenant_id","employee_id","leave_type_id","period_start");

-- ─────────────────────────────────────────────────────────────────
-- [1] sql/0040（原檔 packages/db/sql/0040_requirements_2026_09_23.sql，全文）
-- ─────────────────────────────────────────────────────────────────
-- =====================================================================
-- 0040  需求補齊（2026-09-23）：六張新表的 RLS／禁刪／稽核／CHECK／凍結 trigger、
--       特休桶改期間制、放款簽核狀態、專案成員角色四值、技師 key 中文化、
--       生日照片 bucket
--
-- 表結構由 drizzle migration 0050 建立／加欄（六張新表 overtime_settlements／
-- festival_bonuses／birthday_gifts／duty_rosters／employee_profile_change_requests／
-- disbursement_approval_steps；leave_balances 加 period_start／period_end／source／
-- note 並換唯一鍵；leave_requests.beyond_cap*、disbursements 簽核五欄、
-- project_subcontract_payments 驗收三欄、project_settings.default_share_pct_by_role、
-- payslips.sent_at／sent_to）。本檔放 drizzle 管不了的事：
--   [A] 六張新表 RLS ENABLE 不給 policy（比照 sql/0034 [A]：前端不直接讀，
--       讀寫皆走 API service_role）。
--   [B] 六張新表的 trigger：
--         overtime_settlements、festival_bonuses：no_hard_delete＋audit_all＋
--           set_updated_at＋forbid_paid_row_mutation（[C]）
--         birthday_gifts、employee_profile_change_requests：no_hard_delete＋
--           audit_all＋set_updated_at
--         disbursement_approval_steps：no_hard_delete＋audit_all（無 updated_at）
--         duty_rosters：**只掛 audit_all**——排班表不是證據，重新產生要能刪
--   [C] forbid_paid_row_mutation()：sql/0034 forbid_paid_bonus_mutation() 的泛用版
--       ——OLD.status='paid' 就 RAISE（UPDATE／DELETE 皆擋），僅 test/demo 租戶
--       （is_disposable_tenant）放行供整合測試清理。任何有 status／tenant_id
--       兩欄的表都能掛。
--   [D] 新表合法值 CHECK（source／channel／status／festival／duty_type／decision、
--       paid → paid_on、minutes ≥ 0、prorate_months 1..12）。
--   [E] leave_balances 改期間制：舊列 backfill period_start＝make_date(year,1,1)、
--       period_end＝make_date(year,12,31) 後 SET NOT NULL；CHECK period_end ≥
--       period_start、source IN ('manual','auto','migrated')。唯一鍵已由 0050 換成
--       (tenant_id, employee_id, leave_type_id, period_start)。
--   [F] disbursements_status_chk（sql/0029）改含 'pending_approval'、'approved'。
--   [G] RLS helper is_project_lead()（sql/0015）：project_members.role_in_project
--       IN ('lead','manager')——W3 四角色後「經理」與「主辦」同樣可看全部分潤。
--       函式簽名不變、policy 不用重掛；ACL 照 sql/0015 第 92–97 行重申。
--   [H] projects.engineers backfill：jsonb key electrical→電機、hvac→空調、
--       fire→消防（與 project_settings.disciplines 預設值一致）。只改含舊 key 的
--       列，冪等；同時已有中文 key 的列保留中文 key 的值、丟掉舊 key。
--   [I] storage bucket birthday-photos（private，比照 sql/0020）。
--   [J] 欄位 COMMENT。
--
-- 前提：migration 0050 已套用；sql/0018 forbid_hard_delete()／is_disposable_tenant()、
-- sql/0019 audit_row()（sql/0033 起記操作者）、sql/0027 set_updated_at()、
-- sql/0015 current_tenant_id() 已存在。
-- 套用方式：Supabase SQL Editor（或 docs/套用-2026-09-23-需求補齊.sql 合併檔）。
-- 冪等：DROP TRIGGER IF EXISTS＋CREATE、DROP CONSTRAINT IF EXISTS＋ADD、
-- CREATE OR REPLACE、backfill 只碰 NULL／含舊 key 的列、SET NOT NULL 可重跑、
-- bucket ON CONFLICT DO NOTHING、COMMENT 可重設。
-- =====================================================================

-- ─────────────────────────────────────────────────────────────────────
-- [A] RLS：ENABLE，不給 policy
-- ─────────────────────────────────────────────────────────────────────
ALTER TABLE public.overtime_settlements ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.festival_bonuses ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.birthday_gifts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.duty_rosters ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.employee_profile_change_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.disbursement_approval_steps ENABLE ROW LEVEL SECURITY;

-- ─────────────────────────────────────────────────────────────────────
-- [C] forbid_paid_row_mutation()：status='paid' 的列凍結（泛用版；先建函式，[B] 才掛）
-- ─────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.forbid_paid_row_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.status IS DISTINCT FROM 'paid' THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;

  -- 同 0018/0019/0034：僅 test/demo 租戶放行，供整合測試清理已發放的測試資料。
  IF public.is_disposable_tenant(OLD.tenant_id) THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;

  RAISE EXCEPTION
    '% 已發放（paid），不可 %——發放紀錄是凍結快照，不可覆蓋（見 sql/0040 [C]）。',
    TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$;

COMMENT ON FUNCTION public.forbid_paid_row_mutation() IS
  '泛用「已發放即凍結」：掛在有 status／tenant_id 的表，OLD.status=paid 即禁止 UPDATE/DELETE。僅 test/demo 租戶（is_disposable_tenant）放行供整合測試清理。sql/0034 forbid_paid_bonus_mutation 的泛用版。';

-- ─────────────────────────────────────────────────────────────────────
-- [B] trigger
-- ─────────────────────────────────────────────────────────────────────
-- overtime_settlements：禁刪＋稽核＋updated_at＋paid 凍結
DROP TRIGGER IF EXISTS no_hard_delete ON public.overtime_settlements;
CREATE TRIGGER no_hard_delete
  BEFORE DELETE ON public.overtime_settlements
  FOR EACH ROW EXECUTE FUNCTION public.forbid_hard_delete();
DROP TRIGGER IF EXISTS audit_all ON public.overtime_settlements;
CREATE TRIGGER audit_all
  AFTER INSERT OR UPDATE OR DELETE ON public.overtime_settlements
  FOR EACH ROW EXECUTE FUNCTION public.audit_row();
DROP TRIGGER IF EXISTS set_updated_at ON public.overtime_settlements;
CREATE TRIGGER set_updated_at
  BEFORE UPDATE ON public.overtime_settlements
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
DROP TRIGGER IF EXISTS forbid_paid_row_mutation ON public.overtime_settlements;
CREATE TRIGGER forbid_paid_row_mutation
  BEFORE UPDATE OR DELETE ON public.overtime_settlements
  FOR EACH ROW EXECUTE FUNCTION public.forbid_paid_row_mutation();

-- festival_bonuses：禁刪＋稽核＋updated_at＋paid 凍結
DROP TRIGGER IF EXISTS no_hard_delete ON public.festival_bonuses;
CREATE TRIGGER no_hard_delete
  BEFORE DELETE ON public.festival_bonuses
  FOR EACH ROW EXECUTE FUNCTION public.forbid_hard_delete();
DROP TRIGGER IF EXISTS audit_all ON public.festival_bonuses;
CREATE TRIGGER audit_all
  AFTER INSERT OR UPDATE OR DELETE ON public.festival_bonuses
  FOR EACH ROW EXECUTE FUNCTION public.audit_row();
DROP TRIGGER IF EXISTS set_updated_at ON public.festival_bonuses;
CREATE TRIGGER set_updated_at
  BEFORE UPDATE ON public.festival_bonuses
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
DROP TRIGGER IF EXISTS forbid_paid_row_mutation ON public.festival_bonuses;
CREATE TRIGGER forbid_paid_row_mutation
  BEFORE UPDATE OR DELETE ON public.festival_bonuses
  FOR EACH ROW EXECUTE FUNCTION public.forbid_paid_row_mutation();

-- birthday_gifts：禁刪＋稽核＋updated_at
DROP TRIGGER IF EXISTS no_hard_delete ON public.birthday_gifts;
CREATE TRIGGER no_hard_delete
  BEFORE DELETE ON public.birthday_gifts
  FOR EACH ROW EXECUTE FUNCTION public.forbid_hard_delete();
DROP TRIGGER IF EXISTS audit_all ON public.birthday_gifts;
CREATE TRIGGER audit_all
  AFTER INSERT OR UPDATE OR DELETE ON public.birthday_gifts
  FOR EACH ROW EXECUTE FUNCTION public.audit_row();
DROP TRIGGER IF EXISTS set_updated_at ON public.birthday_gifts;
CREATE TRIGGER set_updated_at
  BEFORE UPDATE ON public.birthday_gifts
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- duty_rosters：只稽核，不禁刪（重新產生要能刪）
DROP TRIGGER IF EXISTS audit_all ON public.duty_rosters;
CREATE TRIGGER audit_all
  AFTER INSERT OR UPDATE OR DELETE ON public.duty_rosters
  FOR EACH ROW EXECUTE FUNCTION public.audit_row();

-- employee_profile_change_requests：禁刪＋稽核＋updated_at
DROP TRIGGER IF EXISTS no_hard_delete ON public.employee_profile_change_requests;
CREATE TRIGGER no_hard_delete
  BEFORE DELETE ON public.employee_profile_change_requests
  FOR EACH ROW EXECUTE FUNCTION public.forbid_hard_delete();
DROP TRIGGER IF EXISTS audit_all ON public.employee_profile_change_requests;
CREATE TRIGGER audit_all
  AFTER INSERT OR UPDATE OR DELETE ON public.employee_profile_change_requests
  FOR EACH ROW EXECUTE FUNCTION public.audit_row();
DROP TRIGGER IF EXISTS set_updated_at ON public.employee_profile_change_requests;
CREATE TRIGGER set_updated_at
  BEFORE UPDATE ON public.employee_profile_change_requests
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- disbursement_approval_steps：禁刪＋稽核（無 updated_at 欄位）
DROP TRIGGER IF EXISTS no_hard_delete ON public.disbursement_approval_steps;
CREATE TRIGGER no_hard_delete
  BEFORE DELETE ON public.disbursement_approval_steps
  FOR EACH ROW EXECUTE FUNCTION public.forbid_hard_delete();
DROP TRIGGER IF EXISTS audit_all ON public.disbursement_approval_steps;
CREATE TRIGGER audit_all
  AFTER INSERT OR UPDATE OR DELETE ON public.disbursement_approval_steps
  FOR EACH ROW EXECUTE FUNCTION public.audit_row();

-- ─────────────────────────────────────────────────────────────────────
-- [D] 新表合法值防呆
-- ─────────────────────────────────────────────────────────────────────
ALTER TABLE public.overtime_settlements DROP CONSTRAINT IF EXISTS overtime_settlements_source_chk;
ALTER TABLE public.overtime_settlements ADD CONSTRAINT overtime_settlements_source_chk
  CHECK (source IN ('beyond_cap', 'manual'));
ALTER TABLE public.overtime_settlements DROP CONSTRAINT IF EXISTS overtime_settlements_channel_chk;
ALTER TABLE public.overtime_settlements ADD CONSTRAINT overtime_settlements_channel_chk
  CHECK (channel IN ('cash', 'comp_time', 'payroll'));
ALTER TABLE public.overtime_settlements DROP CONSTRAINT IF EXISTS overtime_settlements_status_chk;
ALTER TABLE public.overtime_settlements ADD CONSTRAINT overtime_settlements_status_chk
  CHECK (status IN ('draft', 'paid'));
-- 已發放就必須有發放日（同 sql/0029 disbursements_paid_chk、sql/0034 的理由）。
ALTER TABLE public.overtime_settlements DROP CONSTRAINT IF EXISTS overtime_settlements_paid_requires_paid_on_chk;
ALTER TABLE public.overtime_settlements ADD CONSTRAINT overtime_settlements_paid_requires_paid_on_chk
  CHECK (status <> 'paid' OR paid_on IS NOT NULL);
ALTER TABLE public.overtime_settlements DROP CONSTRAINT IF EXISTS overtime_settlements_minutes_chk;
ALTER TABLE public.overtime_settlements ADD CONSTRAINT overtime_settlements_minutes_chk
  CHECK (minutes >= 0);

ALTER TABLE public.festival_bonuses DROP CONSTRAINT IF EXISTS festival_bonuses_festival_chk;
ALTER TABLE public.festival_bonuses ADD CONSTRAINT festival_bonuses_festival_chk
  CHECK (festival IN ('lunar_new_year', 'dragon_boat', 'mid_autumn', 'other'));
ALTER TABLE public.festival_bonuses DROP CONSTRAINT IF EXISTS festival_bonuses_status_chk;
ALTER TABLE public.festival_bonuses ADD CONSTRAINT festival_bonuses_status_chk
  CHECK (status IN ('draft', 'paid'));
ALTER TABLE public.festival_bonuses DROP CONSTRAINT IF EXISTS festival_bonuses_paid_requires_paid_on_chk;
ALTER TABLE public.festival_bonuses ADD CONSTRAINT festival_bonuses_paid_requires_paid_on_chk
  CHECK (status <> 'paid' OR paid_on IS NOT NULL);
ALTER TABLE public.festival_bonuses DROP CONSTRAINT IF EXISTS festival_bonuses_prorate_months_chk;
ALTER TABLE public.festival_bonuses ADD CONSTRAINT festival_bonuses_prorate_months_chk
  CHECK (prorate_months IS NULL OR (prorate_months >= 1 AND prorate_months <= 12));

ALTER TABLE public.duty_rosters DROP CONSTRAINT IF EXISTS duty_rosters_duty_type_chk;
ALTER TABLE public.duty_rosters ADD CONSTRAINT duty_rosters_duty_type_chk
  CHECK (duty_type IN ('duty', 'reception'));

ALTER TABLE public.employee_profile_change_requests DROP CONSTRAINT IF EXISTS employee_profile_change_requests_status_chk;
ALTER TABLE public.employee_profile_change_requests ADD CONSTRAINT employee_profile_change_requests_status_chk
  CHECK (status IN ('pending', 'approved', 'rejected'));

ALTER TABLE public.disbursement_approval_steps DROP CONSTRAINT IF EXISTS disbursement_approval_steps_decision_chk;
ALTER TABLE public.disbursement_approval_steps ADD CONSTRAINT disbursement_approval_steps_decision_chk
  CHECK (decision IN ('pending', 'approved', 'rejected'));

-- ─────────────────────────────────────────────────────────────────────
-- [E] leave_balances 改期間制：backfill → NOT NULL → CHECK
-- ─────────────────────────────────────────────────────────────────────
-- 舊曆年列：期間＝該年 1/1～12/31（只補 NULL 的列；重跑不覆蓋已搬遷成週年期的列）。
UPDATE public.leave_balances
   SET period_start = make_date(year, 1, 1),
       period_end   = make_date(year, 12, 31)
 WHERE period_start IS NULL OR period_end IS NULL;

ALTER TABLE public.leave_balances ALTER COLUMN period_start SET NOT NULL;
ALTER TABLE public.leave_balances ALTER COLUMN period_end SET NOT NULL;

ALTER TABLE public.leave_balances DROP CONSTRAINT IF EXISTS leave_balances_period_chk;
ALTER TABLE public.leave_balances ADD CONSTRAINT leave_balances_period_chk
  CHECK (period_end >= period_start);
ALTER TABLE public.leave_balances DROP CONSTRAINT IF EXISTS leave_balances_source_chk;
ALTER TABLE public.leave_balances ADD CONSTRAINT leave_balances_source_chk
  CHECK (source IN ('manual', 'auto', 'migrated'));

-- ─────────────────────────────────────────────────────────────────────
-- [F] disbursements.status 合法值：加簽核兩態
-- ─────────────────────────────────────────────────────────────────────
ALTER TABLE public.disbursements DROP CONSTRAINT IF EXISTS disbursements_status_chk;
ALTER TABLE public.disbursements ADD CONSTRAINT disbursements_status_chk
  CHECK (status IN ('draft', 'pending_approval', 'approved', 'paid', 'void'));

-- ─────────────────────────────────────────────────────────────────────
-- [G] is_project_lead()：role_in_project IN ('lead','manager')
-- ─────────────────────────────────────────────────────────────────────
-- 呼叫者是否為某專案的負責人：projects.lead_emp_id 指向自己，或在
-- project_members 內以 role_in_project IN ('lead','manager') 掛在該專案
-- （W3 四角色：manager 經理／lead 主辦／support 支援／member 組員；前兩者可看全部分潤）。
CREATE OR REPLACE FUNCTION public.is_project_lead(p_project_id uuid)
RETURNS boolean LANGUAGE sql SECURITY DEFINER STABLE SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.employees e
    WHERE e.user_id = auth.uid()
      AND e.tenant_id = public.current_tenant_id()
      AND (
        EXISTS (
          SELECT 1 FROM public.projects p
          WHERE p.id = p_project_id
            AND p.tenant_id = public.current_tenant_id()
            AND p.lead_emp_id = e.id
        )
        OR EXISTS (
          SELECT 1 FROM public.project_members pm
          WHERE pm.project_id = p_project_id
            AND pm.tenant_id = public.current_tenant_id()
            AND pm.employee_id = e.id
            AND pm.role_in_project IN ('lead', 'manager')
        )
      )
  );
$$;

-- ACL 與 sql/0015 第 92–97 行一致（REVOKE PUBLIC；GRANT anon／authenticated／service_role）。
REVOKE ALL ON FUNCTION public.is_project_lead(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.is_project_lead(uuid) TO anon, authenticated, service_role;

-- ─────────────────────────────────────────────────────────────────────
-- [H] projects.engineers：舊 key → 中文科別（只改含舊 key 的列；冪等）
-- ─────────────────────────────────────────────────────────────────────
-- 同一列若已有中文 key（例如同時有 'electrical' 與 '電機'），保留中文 key 的值、丟掉舊 key。
UPDATE public.projects p
   SET engineers = (
     SELECT coalesce(jsonb_object_agg(x.new_key, x.value), '{}'::jsonb)
       FROM (
         SELECT e.key AS old_key,
                CASE e.key
                  WHEN 'electrical' THEN '電機'
                  WHEN 'hvac'       THEN '空調'
                  WHEN 'fire'       THEN '消防'
                  ELSE e.key
                END AS new_key,
                e.value
           FROM jsonb_each(p.engineers) e
       ) x
      WHERE NOT (x.old_key IN ('electrical', 'hvac', 'fire') AND p.engineers ? x.new_key)
   )
 WHERE jsonb_typeof(p.engineers) = 'object'
   AND p.engineers ?| ARRAY['electrical', 'hvac', 'fire'];

-- ─────────────────────────────────────────────────────────────────────
-- [I] storage bucket：birthday-photos（private，比照 sql/0020）
-- ─────────────────────────────────────────────────────────────────────
INSERT INTO storage.buckets (id, name, public)
VALUES ('birthday-photos', 'birthday-photos', false)
ON CONFLICT (id) DO NOTHING;

UPDATE storage.buckets
   SET public = false
 WHERE id = 'birthday-photos'
   AND public IS DISTINCT FROM false;

-- ─────────────────────────────────────────────────────────────────────
-- [J] 欄位說明
-- ─────────────────────────────────────────────────────────────────────
COMMENT ON TABLE public.overtime_settlements IS
  '月加班超過上限（overtime.monthlyCapHours，預設 40h）後另行給付的帳：月表核准時自動產生 source=beyond_cap 一列（每人每月一列），HR 標記付款（現金／補休／併薪資）後 paid 凍結。只有老闆與 HR 看得到。';
COMMENT ON TABLE public.festival_bonuses IS
  '三節／節慶 Cash 獎金：每節每年對全體在職員工產生 draft（建議＝去年同節 final 或基準金額 × 到職月數折算），老闆改 final 後一次發放（paid 凍結）。';
COMMENT ON TABLE public.birthday_gifts IS
  '生日紅包登記：一人一年一列，金額／日期／備註／照片（bucket birthday-photos，signed URL 讀取）。';
COMMENT ON TABLE public.duty_rosters IS
  '值日生（duty）／總機（reception）輪播排班：一天一職務一人，只排工作日；重新產生會刪該區間再插入，故不掛 no_hard_delete。';
COMMENT ON TABLE public.employee_profile_change_requests IS
  '員工自改資料審核單：租戶開 formParameters.myDataRequiresApproval 時，非 HR 的 profile 異動先存這裡（changes={col:{from,to}}），HR approve 才套用。';
COMMENT ON TABLE public.disbursement_approval_steps IS
  '放款單簽核關卡（承辦主管鏈 → 會計 → 老闆），與假單 approval_steps 分表；round＝第幾輪送簽，舊輪保留作軌跡。';
COMMENT ON COLUMN public.leave_balances.period_start IS
  '餘額桶期間起日（含）。週年制＝到職日週年；舊曆年列 backfill 為 1/1。唯一鍵 (tenant_id, employee_id, leave_type_id, period_start)。';
COMMENT ON COLUMN public.leave_balances.period_end IS
  '餘額桶期間迄日（含）。舊曆年列 backfill 為 12/31。';
COMMENT ON COLUMN public.leave_balances.source IS
  'manual HR 手動｜auto 年度給假自動發放｜migrated 由曆年列搬遷（note 記原年份）。';
COMMENT ON COLUMN public.leave_balances.year IS
  '＝extract(year from period_start)，API 寫入時同步；保留給舊讀點。';
COMMENT ON COLUMN public.leave_requests.beyond_cap IS
  'kind=ot 送單時本月累計（已核准＋本張）是否超過 overtime.monthlyCapHours；只標記不擋單，超額在月表核准時歸入 overtime_settlements。';
COMMENT ON COLUMN public.leave_requests.beyond_cap_detail IS
  '{approvedBeforeMinutes, requestedMinutes, capMinutes}（services/overtime-cap.ts beyondCapCheck）。';
COMMENT ON COLUMN public.disbursements.current_step IS
  '簽核中的待簽關卡（disbursement_approval_steps.step_order）；不在簽核中為 null。';
COMMENT ON COLUMN public.disbursements.approval_round IS
  '送簽輪次，每次 submit +1；0＝從未送簽。';
COMMENT ON COLUMN public.project_subcontract_payments.accepted_on IS
  '本期驗收確認日；null＝未驗收。放款分攤到未驗收期款一律 409 acceptance_required（HR 帶理由可強制）。';
COMMENT ON COLUMN public.project_settings.default_share_pct_by_role IS
  '{manager?, lead?, support?, member?}：pool_pct 模式新增成員未帶 sharePct 時預帶的趴數；空物件＝不預帶。';
COMMENT ON COLUMN public.payslips.sent_at IS
  '薪資條 Email 寄出時間；null＝未寄送。';

-- ── 還原（不可逆部分：新表刪除會連資料一起丟；backfill 無害）─────────────
-- DROP TRIGGER IF EXISTS forbid_paid_row_mutation ON public.festival_bonuses;
-- DROP TRIGGER IF EXISTS forbid_paid_row_mutation ON public.overtime_settlements;
-- DROP FUNCTION IF EXISTS public.forbid_paid_row_mutation();
-- （六張新表的 no_hard_delete／audit_all／set_updated_at 與 CHECK：逐一 DROP TRIGGER／DROP CONSTRAINT IF EXISTS）
-- ALTER TABLE public.leave_balances DROP CONSTRAINT IF EXISTS leave_balances_period_chk;
-- ALTER TABLE public.leave_balances DROP CONSTRAINT IF EXISTS leave_balances_source_chk;
-- ALTER TABLE public.leave_balances ALTER COLUMN period_start DROP NOT NULL;
-- ALTER TABLE public.leave_balances ALTER COLUMN period_end DROP NOT NULL;
-- ALTER TABLE public.disbursements DROP CONSTRAINT IF EXISTS disbursements_status_chk;
-- ALTER TABLE public.disbursements ADD CONSTRAINT disbursements_status_chk CHECK (status IN ('draft', 'paid', 'void'));
-- is_project_lead()：重跑 sql/0015 第 24–47 行的版本即可還原。
-- delete from storage.objects where bucket_id = 'birthday-photos'; delete from storage.buckets where id = 'birthday-photos';
-- （新表本身的刪除留給 drizzle migration 還原，這裡不重複列 DROP TABLE。）

-- ─────────────────────────────────────────────────────────────────
-- [2] sql/0041（原檔 packages/db/sql/0041_audit_gap.sql，全文）
-- ─────────────────────────────────────────────────────────────────
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
