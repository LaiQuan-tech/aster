-- =====================================================================
-- 亞斯特 — 2026-09-12 待套用 SQL（一次跑完）
--
-- 產生自 repo，內容依序為：
--   [1] drizzle migration 0026 ~ 0029（建表／加欄位）
--   [2] sql/0018  證據表禁止實體刪除 trigger
--   [3] sql/0019  稽核軌跡 audit triggers（相依 0018）
--   [4] sql/0020  兩個私有 Storage buckets
--
-- **順序不可調換**：0019 用到 0018 定義的 is_disposable_tenant()；
-- 0018/0019 的 trigger 掛在 0026~0029 建出來的表上。
--
-- 全部語句皆為冪等（IF NOT EXISTS / ON CONFLICT / duplicate_object 例外處理），
-- 重複執行無害。
--
-- ⚠️ 手動套用不會更新 drizzle 的 __drizzle_migrations 紀錄，
--    日後若再跑 `npm run db:migrate`，drizzle 會重跑 0026~0029 ——
--    因為語句冪等，重跑無害，不需額外處理。
-- =====================================================================


-- ─────────────────────────────────────────────────────────────────
-- [1] migration 0026_flashy_moondragon.sql
-- ─────────────────────────────────────────────────────────────────

ALTER TABLE "leave_requests" ADD COLUMN IF NOT EXISTS "deleted_at" timestamp with time zone;
ALTER TABLE "leave_requests" ADD COLUMN IF NOT EXISTS "deleted_by_emp_id" uuid;
ALTER TABLE "leave_requests" ADD COLUMN IF NOT EXISTS "delete_reason" text;
DO $$ BEGIN
 ALTER TABLE "leave_requests" ADD CONSTRAINT "leave_requests_deleted_by_emp_id_employees_id_fk" FOREIGN KEY ("deleted_by_emp_id") REFERENCES "public"."employees"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;


-- ─────────────────────────────────────────────────────────────────
-- [1] migration 0027_glamorous_maggott.sql
-- ─────────────────────────────────────────────────────────────────

ALTER TABLE "announcements" ADD COLUMN IF NOT EXISTS "deleted_at" timestamp with time zone;
ALTER TABLE "announcements" ADD COLUMN IF NOT EXISTS "deleted_by_emp_id" uuid;
ALTER TABLE "announcements" ADD COLUMN IF NOT EXISTS "delete_reason" text;
DO $$ BEGIN
 ALTER TABLE "announcements" ADD CONSTRAINT "announcements_deleted_by_emp_id_employees_id_fk" FOREIGN KEY ("deleted_by_emp_id") REFERENCES "public"."employees"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;


-- ─────────────────────────────────────────────────────────────────
-- [1] migration 0028_smart_mesmero.sql
-- ─────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "announcement_acknowledgements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"version_id" uuid NOT NULL,
	"employee_id" uuid NOT NULL,
	"kind" text DEFAULT 'consent_to_change' NOT NULL,
	"viewed_at" timestamp with time zone,
	"signed_at" timestamp with time zone,
	"signature_sheet_id" uuid,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "announcement_signature_sheets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"version_id" uuid NOT NULL,
	"sheet_no" integer NOT NULL,
	"file_name" text NOT NULL,
	"storage_path" text NOT NULL,
	"size_bytes" integer DEFAULT 0 NOT NULL,
	"content_type" text,
	"content_hash" text,
	"note" text,
	"uploaded_by_emp_id" uuid,
	"uploaded_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "announcement_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"announcement_id" uuid NOT NULL,
	"version_no" integer NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"audience" text DEFAULT 'all' NOT NULL,
	"change_type" text DEFAULT 'initial' NOT NULL,
	"change_note" text,
	"effective_from" date,
	"effective_to" date,
	"requires_signature" boolean DEFAULT false NOT NULL,
	"is_adverse_change" boolean DEFAULT false NOT NULL,
	"content_hash" text,
	"created_by_emp_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "audit_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid,
	"table_name" text NOT NULL,
	"record_id" uuid,
	"action" text NOT NULL,
	"old_row" jsonb,
	"new_row" jsonb,
	"actor_emp_id" uuid,
	"db_user" text,
	"context" text,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE "announcements" ADD COLUMN IF NOT EXISTS "current_version_id" uuid;
DO $$ BEGIN
 ALTER TABLE "announcement_acknowledgements" ADD CONSTRAINT "announcement_acknowledgements_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
 ALTER TABLE "announcement_acknowledgements" ADD CONSTRAINT "announcement_acknowledgements_version_id_announcement_versions_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."announcement_versions"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
 ALTER TABLE "announcement_acknowledgements" ADD CONSTRAINT "announcement_acknowledgements_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."employees"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
 ALTER TABLE "announcement_acknowledgements" ADD CONSTRAINT "announcement_acknowledgements_signature_sheet_id_announcement_signature_sheets_id_fk" FOREIGN KEY ("signature_sheet_id") REFERENCES "public"."announcement_signature_sheets"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
 ALTER TABLE "announcement_signature_sheets" ADD CONSTRAINT "announcement_signature_sheets_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
 ALTER TABLE "announcement_signature_sheets" ADD CONSTRAINT "announcement_signature_sheets_version_id_announcement_versions_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."announcement_versions"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
 ALTER TABLE "announcement_signature_sheets" ADD CONSTRAINT "announcement_signature_sheets_uploaded_by_emp_id_employees_id_fk" FOREIGN KEY ("uploaded_by_emp_id") REFERENCES "public"."employees"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
 ALTER TABLE "announcement_versions" ADD CONSTRAINT "announcement_versions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
 ALTER TABLE "announcement_versions" ADD CONSTRAINT "announcement_versions_announcement_id_announcements_id_fk" FOREIGN KEY ("announcement_id") REFERENCES "public"."announcements"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
 ALTER TABLE "announcement_versions" ADD CONSTRAINT "announcement_versions_created_by_emp_id_employees_id_fk" FOREIGN KEY ("created_by_emp_id") REFERENCES "public"."employees"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS "announcement_acks_version_employee_uq" ON "announcement_acknowledgements" USING btree ("tenant_id","version_id","employee_id");
CREATE INDEX IF NOT EXISTS "announcement_acks_tenant_employee_signed_idx" ON "announcement_acknowledgements" USING btree ("tenant_id","employee_id","signed_at");
CREATE UNIQUE INDEX IF NOT EXISTS "announcement_sheets_version_sheet_uq" ON "announcement_signature_sheets" USING btree ("tenant_id","version_id","sheet_no");
CREATE UNIQUE INDEX IF NOT EXISTS "announcement_versions_ann_version_uq" ON "announcement_versions" USING btree ("tenant_id","announcement_id","version_no");
CREATE INDEX IF NOT EXISTS "announcement_versions_tenant_effective_idx" ON "announcement_versions" USING btree ("tenant_id","effective_from","effective_to");
CREATE INDEX IF NOT EXISTS "audit_logs_tenant_table_record_idx" ON "audit_logs" USING btree ("tenant_id","table_name","record_id");
CREATE INDEX IF NOT EXISTS "audit_logs_tenant_at_idx" ON "audit_logs" USING btree ("tenant_id","at");


-- ─────────────────────────────────────────────────────────────────
-- [1] migration 0029_closed_landau.sql
-- ─────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "expense_categories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"nature" text DEFAULT 'reimbursement' NOT NULL,
	"requires_receipt" boolean DEFAULT true NOT NULL,
	"cross_check_attendance" boolean DEFAULT false NOT NULL,
	"monthly_cap" numeric,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "expense_claim_attachments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"claim_id" uuid NOT NULL,
	"file_name" text NOT NULL,
	"storage_path" text NOT NULL,
	"size_bytes" integer DEFAULT 0 NOT NULL,
	"content_type" text,
	"content_hash" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "expense_claims" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"employee_id" uuid NOT NULL,
	"category_id" uuid NOT NULL,
	"nature" text DEFAULT 'reimbursement' NOT NULL,
	"amount" numeric NOT NULL,
	"incurred_on" date NOT NULL,
	"period" text NOT NULL,
	"note" text,
	"status" text DEFAULT 'submitted' NOT NULL,
	"status_reason" text,
	"settlement_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "expense_settlements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"period" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"reimbursement_total" numeric DEFAULT '0' NOT NULL,
	"allowance_total" numeric DEFAULT '0' NOT NULL,
	"claim_count" integer DEFAULT 0 NOT NULL,
	"note" text,
	"settled_by_emp_id" uuid,
	"settled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);

DO $$ BEGIN
 ALTER TABLE "expense_categories" ADD CONSTRAINT "expense_categories_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
 ALTER TABLE "expense_claim_attachments" ADD CONSTRAINT "expense_claim_attachments_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
 ALTER TABLE "expense_claim_attachments" ADD CONSTRAINT "expense_claim_attachments_claim_id_expense_claims_id_fk" FOREIGN KEY ("claim_id") REFERENCES "public"."expense_claims"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
 ALTER TABLE "expense_claims" ADD CONSTRAINT "expense_claims_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
 ALTER TABLE "expense_claims" ADD CONSTRAINT "expense_claims_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."employees"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
 ALTER TABLE "expense_claims" ADD CONSTRAINT "expense_claims_category_id_expense_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."expense_categories"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
 ALTER TABLE "expense_claims" ADD CONSTRAINT "expense_claims_settlement_id_expense_settlements_id_fk" FOREIGN KEY ("settlement_id") REFERENCES "public"."expense_settlements"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
 ALTER TABLE "expense_settlements" ADD CONSTRAINT "expense_settlements_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
 ALTER TABLE "expense_settlements" ADD CONSTRAINT "expense_settlements_settled_by_emp_id_employees_id_fk" FOREIGN KEY ("settled_by_emp_id") REFERENCES "public"."employees"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS "expense_categories_tenant_code_uq" ON "expense_categories" USING btree ("tenant_id","code");
CREATE INDEX IF NOT EXISTS "expense_claim_attachments_tenant_claim_idx" ON "expense_claim_attachments" USING btree ("tenant_id","claim_id");
CREATE INDEX IF NOT EXISTS "expense_claims_tenant_period_status_idx" ON "expense_claims" USING btree ("tenant_id","period","status");
CREATE INDEX IF NOT EXISTS "expense_claims_tenant_employee_incurred_idx" ON "expense_claims" USING btree ("tenant_id","employee_id","incurred_on");
CREATE UNIQUE INDEX IF NOT EXISTS "expense_settlements_tenant_period_uq" ON "expense_settlements" USING btree ("tenant_id","period");


-- ─────────────────────────────────────────────────────────────────
-- [2] sql/0018_forbid_hard_delete.sql
-- ─────────────────────────────────────────────────────────────────

-- =====================================================================
-- 0018  證據表禁止實體刪除（模組二第 2 條：「嚴禁系統刪除」）
--
-- 為何不能只做在應用層：
--   API 全程使用 service_role key，**BYPASS RLS**（見 0001/0005 檔頭）。
--   因此 RLS policy 擋不住 DELETE，移除端點也只擋掉一條路徑。
--   BEFORE DELETE trigger 不受 RLS bypass 影響，是唯一對 service_role
--   仍然生效的防線。
--
-- 威脅模型（誠實說明能擋什麼、不能擋什麼）：
--   ✓ 擋：未來有人再加一個硬刪端點、管理介面誤觸、清理腳本寫錯
--   ✗ 不擋：有 DB superuser 權限者可直接 DROP TRIGGER
--   目的是讓「刪除」不可能在正常操作中發生，必須是明確且留痕的特權行為。
--
-- 放行條件：該列所屬 tenant 的 status IN ('test', 'demo')。
--   • 'active'（tenants.status 預設值）＝正式租戶，永遠擋住。
--   • 'test'：整合測試租戶，由 provisionTenant 在 NODE_ENV=test 且
--     ASTER_PROVISION_TEST_TENANTS=true 時標記，供測試清理。
--   • 'demo'：示範租戶。demo seed 需重複覆寫示範資料，而示範資料不是證據。
--     POST /demo/seed 亦已加上「租戶須為 demo/test」的前置檢查——正式租戶
--     跑 demo seed 會刪掉真實出勤與請假紀錄，那本身就是本條禁止的事。
--   把正式租戶改成 'test'/'demo' 才能刪它的資料——那本身是對 tenants 表的
--   可見異動，不是悄悄發生的事。
--
-- 保護範圍：
--   客戶明文要求（模組二第 2 條）：leave_requests、request_attachments、
--     approval_steps、announcements
--   法定保存義務（勞基法 §30 V 出勤紀錄 5 年、§23 II 工資清冊 5 年）：
--     punch_records、attendance_days、payslips
--   金流憑證（模組三）：expense_claims、expense_claim_attachments、
--     expense_settlements —— 報銷單與憑證是稅上主張「非所得代墊費用」的
--     依據，且營所稅列費用亦需憑證。本模組刻意不提供刪除端點，
--     撤回走 status='cancelled'。
--   ※ 若只要客戶明文那一組，刪掉下方第二個 FOREACH 區塊即可。
--
-- 套用方式：經 Supabase Management API query 端點（同 0001~0017）。
-- 冪等：DROP TRIGGER IF EXISTS 後重建，可重複執行。
-- 可逆：見檔末的還原指令。
-- =====================================================================

-- 共用判斷：這個租戶的資料是否可被實體刪除（0019 的稽核表也會用）。
CREATE OR REPLACE FUNCTION public.is_disposable_tenant(p_tenant_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
  SELECT coalesce(
    (SELECT t.status IN ('test', 'demo') FROM public.tenants t WHERE t.id = p_tenant_id),
    false
  );
$$;

COMMENT ON FUNCTION public.is_disposable_tenant(uuid) IS
  '租戶資料是否可實體刪除：僅 status 為 test/demo 者。正式租戶（active）一律 false。';

CREATE OR REPLACE FUNCTION public.forbid_hard_delete()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  -- 測試／示範租戶放行（資料非證據）。
  IF public.is_disposable_tenant(OLD.tenant_id) THEN
    RETURN OLD;
  END IF;

  RAISE EXCEPTION
    '% 為證據表，禁止實體刪除（模組二第 2 條）。請改用軟刪除欄位；'
    '保存義務見勞基法 §30 V / §23 II。',
    TG_TABLE_NAME
    USING ERRCODE = 'restrict_violation';
END;
$$;

COMMENT ON FUNCTION public.forbid_hard_delete() IS
  '證據表 BEFORE DELETE 攔截。僅在所屬 tenant.status IN (''test'',''demo'') 時放行。';

-- ── 客戶明文要求保留的四張表 ────────────────────────────────────────
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'leave_requests',
    'request_attachments',
    'approval_steps',
    'announcements'
  ]
  LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS no_hard_delete ON public.%I', t);
    EXECUTE format(
      'CREATE TRIGGER no_hard_delete BEFORE DELETE ON public.%I '
      'FOR EACH ROW EXECUTE FUNCTION public.forbid_hard_delete()', t);
  END LOOP;
END $$;

-- ── 法定保存義務的三張表（§30 V 出勤紀錄、§23 II 工資清冊）──────────
-- 客戶本條未明文提及，但屬同一性質且有法定年限。不要的話刪掉此區塊。
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'punch_records',
    'attendance_days',
    'payslips',
    'expense_claims',
    'expense_claim_attachments',
    'expense_settlements'
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
--   FOREACH t IN ARRAY ARRAY['leave_requests','request_attachments',
--     'approval_steps','announcements','punch_records','attendance_days','payslips',
--     'expense_claims','expense_claim_attachments','expense_settlements']
--   LOOP EXECUTE format('DROP TRIGGER IF EXISTS no_hard_delete ON public.%I', t); END LOOP;
-- END $$;
-- DROP FUNCTION IF EXISTS public.forbid_hard_delete();


-- ─────────────────────────────────────────────────────────────────
-- [3] sql/0019_audit_triggers.sql
-- ─────────────────────────────────────────────────────────────────

-- =====================================================================
-- 0019  稽核軌跡 audit triggers
--
-- 專案硬約束：「經手金額的表一律掛 audit trigger」。
-- 本檔是帳本「移植五個缺口」第 1 項（audit_logs）的 DB 層；
-- 表結構由 drizzle migration 0028 建立，本檔只掛 trigger。
--
-- 為何 trigger 而非只靠應用層：
--   API 全程使用 service_role key，BYPASS RLS。應用層的
--   services/audit.ts 可被繞過（漏呼叫、直接對 DB 下 SQL）；
--   trigger 不會。兩者互補：
--     • trigger  → 保證「什麼被改了」不會漏，但不知道應用層的操作者是誰
--       （PostgREST 的 request.jwt.claims 在 service_role 下只有服務身分，
--        沒有使用者），故 actor_emp_id 為 null、只記 db_user。
--     • 應用層   → 補上 actor_emp_id 與 context，但可被繞過。
--   查核時以 (table_name, record_id) 把兩邊的列拼起來看。
--
-- 兩種掛法：
--   A. 全量稽核（INSERT/UPDATE/DELETE）—— 經手金額的表與低量證據表。
--   B. 僅異動稽核（UPDATE/DELETE）—— punch_records / attendance_days
--      這類「只增不改」的高量表。每天每人數筆打卡，稽核 INSERT 只是把寫入
--      量翻倍而毫無資訊（打卡列本身就是那筆紀錄）；**竄改才是要抓的**，
--      而竄改一定是 UPDATE 或 DELETE。
--
-- audit_logs 自身為 append-only：UPDATE 與 DELETE 皆被擋下
-- （可改可刪的稽核軌跡等於沒有）。例外同 0018，僅 test/demo 租戶放行，
-- 否則整合測試會在共用 Supabase 上無限累積列。
--
-- 相依：0018（提供 public.is_disposable_tenant）。請先套用 0018。
-- 套用方式：經 Supabase Management API query 端點（同 0001~0018）。
-- 冪等：DROP TRIGGER IF EXISTS 後重建，可重複執行。
-- 可逆：見檔末。
-- =====================================================================

CREATE OR REPLACE FUNCTION public.audit_row()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_old jsonb;
  v_new jsonb;
  v_any jsonb;
BEGIN
  IF TG_OP = 'INSERT' THEN
    v_new := to_jsonb(NEW);
  ELSIF TG_OP = 'DELETE' THEN
    v_old := to_jsonb(OLD);
  ELSE
    v_old := to_jsonb(OLD);
    v_new := to_jsonb(NEW);
  END IF;

  v_any := coalesce(v_new, v_old);

  INSERT INTO public.audit_logs
    (tenant_id, table_name, record_id, action, old_row, new_row, db_user)
  VALUES (
    nullif(v_any ->> 'tenant_id', '')::uuid,
    TG_TABLE_NAME,
    nullif(v_any ->> 'id', '')::uuid,
    TG_OP,
    v_old,
    v_new,
    current_user
  );

  RETURN NULL; -- AFTER trigger，回傳值不被使用
END;
$$;

COMMENT ON FUNCTION public.audit_row() IS
  '把一列的 INSERT/UPDATE/DELETE 寫進 audit_logs（整列 jsonb）。actor_emp_id 由應用層補。';

-- ── A. 全量稽核：經手金額的表 + 低量證據表 ──────────────────────────
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    -- 經手金額（硬約束明列）
    'payslips',
    'salary_structures',
    'salary_adjustments',
    'leave_balances',
    'comp_time_ledger',
    'non_employee_income',
    'rule_configs',              -- 薪資規則決定算出來的錢，等同經手金額
    'projects',                  -- bonus_pool
    'project_members',           -- share_pct / share_amount
    'project_share_adjustments',
    -- 報銷（模組三）—— nature 欄位決定課稅與投保歸屬，改動必須留痕
    'expense_categories',
    'expense_claims',
    'expense_settlements',
    -- 證據（模組二）
    'leave_requests',
    'approval_steps',
    'announcements',
    'announcement_versions',
    'announcement_signature_sheets',
    'announcement_acknowledgements'
  ]
  LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS audit_all ON public.%I', t);
    EXECUTE format(
      'CREATE TRIGGER audit_all AFTER INSERT OR UPDATE OR DELETE ON public.%I '
      'FOR EACH ROW EXECUTE FUNCTION public.audit_row()', t);
  END LOOP;
END $$;

-- ── B. 僅異動稽核：高量、只增不改的表（見檔頭說明）──────────────────
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'punch_records',
    'attendance_days'
  ]
  LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS audit_mutations ON public.%I', t);
    EXECUTE format(
      'CREATE TRIGGER audit_mutations AFTER UPDATE OR DELETE ON public.%I '
      'FOR EACH ROW EXECUTE FUNCTION public.audit_row()', t);
  END LOOP;
END $$;

-- ── audit_logs 自身：append-only ────────────────────────────────────
CREATE OR REPLACE FUNCTION public.forbid_audit_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  -- 同 0018：僅 test/demo 租戶放行，供整合測試清理。
  IF public.is_disposable_tenant(OLD.tenant_id) THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;

  RAISE EXCEPTION
    'audit_logs 為 append-only，不可 % （可改可刪的稽核軌跡等於沒有）。', TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$;

DROP TRIGGER IF EXISTS audit_logs_append_only ON public.audit_logs;
CREATE TRIGGER audit_logs_append_only
  BEFORE UPDATE OR DELETE ON public.audit_logs
  FOR EACH ROW EXECUTE FUNCTION public.forbid_audit_mutation();

-- ── 還原 ────────────────────────────────────────────────────────────
-- DO $$ DECLARE t text; BEGIN
--   FOREACH t IN ARRAY ARRAY['payslips','salary_structures','salary_adjustments',
--     'leave_balances','comp_time_ledger','non_employee_income','rule_configs',
--     'projects','project_members','project_share_adjustments',
--     'expense_categories','expense_claims','expense_settlements','leave_requests',
--     'approval_steps','announcements','announcement_versions',
--     'announcement_signature_sheets','announcement_acknowledgements']
--   LOOP EXECUTE format('DROP TRIGGER IF EXISTS audit_all ON public.%I', t); END LOOP;
--   FOREACH t IN ARRAY ARRAY['punch_records','attendance_days']
--   LOOP EXECUTE format('DROP TRIGGER IF EXISTS audit_mutations ON public.%I', t); END LOOP;
-- END $$;
-- DROP TRIGGER IF EXISTS audit_logs_append_only ON public.audit_logs;
-- DROP FUNCTION IF EXISTS public.forbid_audit_mutation();
-- DROP FUNCTION IF EXISTS public.audit_row();


-- ─────────────────────────────────────────────────────────────────
-- [4] sql/0020_storage_buckets.sql
-- ─────────────────────────────────────────────────────────────────

-- =====================================================================
-- 0020  私有 Storage buckets
--
-- 專案原本的 bucket（request-attachments 等）是在 Supabase 後台手動建的，
-- repo 內無紀錄。本檔把新增的兩個 bucket 寫成 SQL，讓建置步驟可版控、可重跑。
--
--   • announcement-sheets  紙本簽名單掃描檔（模組二第 3 條）
--   • expense-receipts     報銷憑證（模組三第 1 條）
--
-- 兩者皆為 **private**（public = false）：
--   薪資、簽名、發票都是個資與金流憑證，不可公開讀取。
--   API 以 service_role 上傳，讀取一律走短效期 signed URL（1 小時）。
--
-- RLS：storage.objects 預設啟用 RLS 且無 policy = 一律拒絕，
--   而 service_role 繞過 RLS，故 API 正常運作、前端 anon key 完全讀不到。
--   **這正是要的行為，不要為了「方便」加上 anon 可讀的 policy。**
--
-- 套用方式：Supabase SQL Editor 或 Management API query 端點。
-- 冪等：ON CONFLICT DO NOTHING，可重複執行。
-- 可逆：見檔末（注意：刪 bucket 前需先清空物件）。
-- =====================================================================

insert into storage.buckets (id, name, public)
values
  ('announcement-sheets', 'announcement-sheets', false),
  ('expense-receipts',    'expense-receipts',    false)
on conflict (id) do nothing;

-- 確保既有的 bucket 也不是公開的（若先前被誤建為 public）。
update storage.buckets
   set public = false
 where id in ('announcement-sheets', 'expense-receipts')
   and public is distinct from false;

-- ── 還原 ────────────────────────────────────────────────────────────
-- delete from storage.objects where bucket_id in ('announcement-sheets','expense-receipts');
-- delete from storage.buckets where id in ('announcement-sheets','expense-receipts');

-- =====================================================================
-- 套用後驗證 —— **請分開執行**，不要跟上面一起跑
--
-- 帳本待辦 #4 記著「RLS policy 只在 pglite 以 owner 身分驗過，等於未驗」。
-- 這幾段是讓本次的 trigger 不要重蹈覆轍：貼上去不等於生效，要看到結果。
-- =====================================================================

-- ── 驗證 1：新表與新欄位都在 ─────────────────────────────────────────
-- 預期 8 列。
select table_name
  from information_schema.tables
 where table_schema = 'public'
   and table_name in (
     'audit_logs','announcement_versions','announcement_signature_sheets',
     'announcement_acknowledgements','expense_categories','expense_claims',
     'expense_claim_attachments','expense_settlements')
 order by table_name;

-- 預期 7 列（leave_requests 3 + announcements 4）。
select table_name, column_name
  from information_schema.columns
 where table_schema = 'public'
   and (
     (table_name = 'leave_requests' and column_name in ('deleted_at','deleted_by_emp_id','delete_reason'))
     or (table_name = 'announcements' and column_name in ('deleted_at','deleted_by_emp_id','delete_reason','current_version_id'))
   )
 order by table_name, column_name;

-- ── 驗證 2：trigger 都掛上了 ─────────────────────────────────────────
-- 預期：no_hard_delete 10 個、audit_all 19 個、audit_mutations 2 個、
--       audit_logs_append_only 1 個。
select t.tgname, count(*) as tables
  from pg_trigger t
  join pg_class c on c.oid = t.tgrelid
  join pg_namespace n on n.oid = c.relnamespace
 where n.nspname = 'public'
   and not t.tgisinternal
   and t.tgname in ('no_hard_delete','audit_all','audit_mutations','audit_logs_append_only')
 group by t.tgname
 order by t.tgname;

-- ── 驗證 3：bucket 建好且是私有的 ───────────────────────────────────
-- 預期 2 列，public 皆為 false。
select id, public
  from storage.buckets
 where id in ('announcement-sheets','expense-receipts');

-- ── 驗證 4（最重要）：禁刪 trigger 對 service_role 真的有效 ──────────
--
-- 這一段是唯一能證明「應用層擋不住、DB 層擋得住」的測試。
-- SQL Editor 是以高權限身分執行的 —— 如果連這裡都刪不掉，那 API 的
-- service_role 更刪不掉。
--
-- 以正式租戶（status='active'）的任一張請假單試刪，**預期會失敗並噴出
-- 「leave_requests 為證據表，禁止實體刪除」**。整段包在交易裡並 rollback，
-- 即使 trigger 沒生效也不會真的刪到資料。
do $$
declare
  v_id uuid;
begin
  select lr.id into v_id
    from public.leave_requests lr
    join public.tenants t on t.id = lr.tenant_id
   where t.status = 'active'
   limit 1;

  if v_id is null then
    raise notice '驗證 4 略過：找不到正式租戶的請假單可供測試';
    return;
  end if;

  begin
    delete from public.leave_requests where id = v_id;
    raise warning '❌ 驗證 4 失敗：刪除成功了，trigger 沒有生效';
    raise exception 'rollback_on_purpose';
  exception
    when sqlstate '23001' then
      raise notice '✅ 驗證 4 通過：trigger 擋下了刪除';
    when others then
      if sqlstate = 'P0001' and sqlerrm = 'rollback_on_purpose' then
        raise notice '（已回滾，未實際刪除）';
      else
        raise notice '驗證 4 回應：% (%)', sqlerrm, sqlstate;
      end if;
  end;
end $$;

-- ── 驗證 5：稽核 trigger 有在寫 ─────────────────────────────────────
-- 對 rule_configs 做一次無害的 touch，然後看 audit_logs 有沒有新列。
-- 同樣包在 DO 區塊裡，不改變任何實際值。
do $$
declare
  v_before bigint;
  v_after bigint;
  v_id uuid;
begin
  select count(*) into v_before from public.audit_logs;
  select id into v_id from public.rule_configs limit 1;
  if v_id is null then
    raise notice '驗證 5 略過：沒有 rule_configs 可測';
    return;
  end if;
  -- 值不變的 update：rule_configs 內容不受影響，但會觸發稽核寫入一列。
  -- 那一列是「驗證時留下的」，可保留（它本身就是稽核有生效的證據）。
  update public.rule_configs set version = version where id = v_id;
  select count(*) into v_after from public.audit_logs;
  if v_after > v_before then
    raise notice '✅ 驗證 5 通過：audit_logs 新增了 % 列', v_after - v_before;
  else
    raise warning '❌ 驗證 5 失敗：audit_logs 沒有新列，稽核 trigger 沒生效';
  end if;
end $$;
