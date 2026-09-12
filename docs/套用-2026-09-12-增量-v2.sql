-- =====================================================================
-- 亞斯特 — 2026-09-12 增量 SQL 第二版（員工預支，模組三第 2、3 條）
--
-- ⚠️ **本檔取代先前那份「增量 SQL」**（那份會建出 trip_advances）。
--    出差預支與零用金預支已合併為單一的 `advances` 表——
--    未核銷預支是離職扣回的依據，分兩張表則離職結算要查兩處，
--    一定有人漏查，而漏查的那筆就是收不回來的錢。
--    **若先前那份已經跑過，請看檔末的「補救」。**
--
-- 前提：已套用 2026-09-12 的第一批（migration 0026~0029、sql/0018~0020）。
-- 內容：
--   [1] migration 0030 —— advances、expense_settings 兩張新表 + 既有表加欄位
--   [2] 把 advances 納入既有的禁刪與稽核 trigger（金流表必須留痕）
--   [3] migration 0031 —— projects.fiscal_year + 編號唯一索引（模組四第 1 條）
--
-- 全部冪等，重複執行無害。
-- ⚠️ [3] 有一個前置檢查要先跑（既有專案若有重複編號，索引會建不起來）。
-- =====================================================================

-- ─────────────────────────────────────────────────────────────────
-- [1] migration 0030
-- ─────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "advances" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"kind" text DEFAULT 'trip' NOT NULL,
	"request_id" uuid NOT NULL,
	"employee_id" uuid NOT NULL,
	"amount" numeric NOT NULL,
	"status" text DEFAULT 'requested' NOT NULL,
	"payout_channel" text,
	"paid_at" timestamp with time zone,
	"paid_by_emp_id" uuid,
	"actual_total" numeric,
	"balance" numeric,
	"balance_handling" text,
	"recovery_period" text,
	"settled_at" timestamp with time zone,
	"settled_by_emp_id" uuid,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "expense_settings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"advance_threshold" numeric DEFAULT '5000' NOT NULL,
	"advance_overdue_days" integer DEFAULT 30 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE "expense_categories" ADD COLUMN IF NOT EXISTS "requires_trip_approval" boolean DEFAULT false NOT NULL;
ALTER TABLE "expense_claims" ADD COLUMN IF NOT EXISTS "trip_request_id" uuid;
ALTER TABLE "expense_claims" ADD COLUMN IF NOT EXISTS "advance_id" uuid;
ALTER TABLE "leave_requests" ADD COLUMN IF NOT EXISTS "trip_scope" text;
ALTER TABLE "leave_requests" ADD COLUMN IF NOT EXISTS "estimated_cost" numeric;
ALTER TABLE "leave_requests" ADD COLUMN IF NOT EXISTS "advance_requested" numeric;
ALTER TABLE "leave_requests" ADD COLUMN IF NOT EXISTS "trip_report" text;
DO $$ BEGIN
 ALTER TABLE "advances" ADD CONSTRAINT "advances_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
 ALTER TABLE "advances" ADD CONSTRAINT "advances_request_id_leave_requests_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."leave_requests"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
 ALTER TABLE "advances" ADD CONSTRAINT "advances_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."employees"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
 ALTER TABLE "advances" ADD CONSTRAINT "advances_paid_by_emp_id_employees_id_fk" FOREIGN KEY ("paid_by_emp_id") REFERENCES "public"."employees"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
 ALTER TABLE "advances" ADD CONSTRAINT "advances_settled_by_emp_id_employees_id_fk" FOREIGN KEY ("settled_by_emp_id") REFERENCES "public"."employees"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
 ALTER TABLE "expense_settings" ADD CONSTRAINT "expense_settings_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

CREATE INDEX IF NOT EXISTS "advances_tenant_employee_status_idx" ON "advances" USING btree ("tenant_id","employee_id","status");
CREATE INDEX IF NOT EXISTS "advances_tenant_recovery_period_idx" ON "advances" USING btree ("tenant_id","recovery_period");
CREATE UNIQUE INDEX IF NOT EXISTS "expense_settings_tenant_uq" ON "expense_settings" USING btree ("tenant_id");
DO $$ BEGIN
 ALTER TABLE "expense_claims" ADD CONSTRAINT "expense_claims_trip_request_id_leave_requests_id_fk" FOREIGN KEY ("trip_request_id") REFERENCES "public"."leave_requests"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
 ALTER TABLE "expense_claims" ADD CONSTRAINT "expense_claims_advance_id_advances_id_fk" FOREIGN KEY ("advance_id") REFERENCES "public"."advances"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

-- ─────────────────────────────────────────────────────────────────
-- [2] 把 advances 納入禁刪與稽核
-- ─────────────────────────────────────────────────────────────────

DROP TRIGGER IF EXISTS no_hard_delete ON public.advances;
CREATE TRIGGER no_hard_delete BEFORE DELETE ON public.advances
  FOR EACH ROW EXECUTE FUNCTION public.forbid_hard_delete();

DROP TRIGGER IF EXISTS audit_all ON public.advances;
CREATE TRIGGER audit_all AFTER INSERT OR UPDATE OR DELETE ON public.advances
  FOR EACH ROW EXECUTE FUNCTION public.audit_row();

-- ─────────────────────────────────────────────────────────────────
-- [3] migration 0031 —— 專案編號與歸屬年度（模組四第 1 條）
-- ─────────────────────────────────────────────────────────────────
-- 編號（code）是識別碼，會印在合約與請款單上，建立後不可變更；
-- 歸屬年度（fiscal_year）是分析維度，可人工調整。兩者刻意分開。
--
-- ⚠️ **先跑這一條**，確認既有資料沒有重複編號，否則唯一索引會建失敗：
--
--   select tenant_id, code, count(*)
--     from public.projects
--    where code is not null
--    group by tenant_id, code
--   having count(*) > 1;
--
-- 有列出來就先把重複的改掉（改哪一筆由業務決定，不要系統亂改）再往下跑。
-- 沒有列出來（No rows）就可以直接跑下面三條。

ALTER TABLE public.projects ADD COLUMN IF NOT EXISTS "fiscal_year" integer;

-- code 可空，Postgres 視 NULL 互不相等，所以舊資料沒編號不會互撞。
CREATE UNIQUE INDEX IF NOT EXISTS "projects_tenant_code_uq"
  ON public.projects USING btree ("tenant_id", "code");

-- 既有專案回填歸屬年度＝建立年（與新建的預設值一致）。
-- 只補空值，不覆蓋任何已填的資料。要略過這一條也可以，之後手動填。
UPDATE public.projects
   SET fiscal_year = extract(year from created_at)::int
 WHERE fiscal_year IS NULL;

-- ─────────────────────────────────────────────────────────────────
-- 驗證（**分開跑**，一次只跑這一條）
-- ─────────────────────────────────────────────────────────────────
-- select
--   (select count(*) from information_schema.tables
--     where table_schema='public' and table_name in ('advances','expense_settings'))
--                                                                as "新表(預期2)",
--   (select count(*) from information_schema.columns
--     where table_schema='public' and (
--       (table_name='leave_requests' and column_name in
--         ('trip_scope','estimated_cost','advance_requested','trip_report'))
--       or (table_name='expense_categories' and column_name='requires_trip_approval')
--       or (table_name='expense_claims' and column_name in ('trip_request_id','advance_id'))))
--                                                                as "新欄位(預期7)",
--   (select count(*) from pg_trigger t
--      join pg_class c on c.oid=t.tgrelid
--      join pg_namespace n on n.oid=c.relnamespace
--     where n.nspname='public' and not t.tgisinternal and c.relname='advances')
--                                                                as "advances trigger(預期2)",
--   (select count(*) from information_schema.columns
--     where table_schema='public' and table_name='projects' and column_name='fiscal_year')
--                                                                as "projects.fiscal_year(預期1)",
--   (select count(*) from pg_indexes
--     where schemaname='public' and indexname='projects_tenant_code_uq')
--                                                                as "編號唯一索引(預期1)";

-- ─────────────────────────────────────────────────────────────────
-- 補救：若先前那份增量 SQL 已經跑過（存在 trip_advances）
-- ─────────────────────────────────────────────────────────────────
-- trip_advances 尚無任何資料時直接丟掉即可（它只存在幾小時，且要先
-- 撥款才會有列）。有資料就先確認再處理，不要盲目 drop。
--
--   select count(*) from public.trip_advances;   -- 先看有沒有資料
--
-- 確認為 0 之後：
--   drop trigger if exists no_hard_delete on public.trip_advances;
--   drop trigger if exists audit_all      on public.trip_advances;
--   drop table if exists public.trip_advances;
