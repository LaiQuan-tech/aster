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
--   [4] migration 0032 + sql/0021 —— 專案案情狀態與封存（模組四第 2 條）
--   [5] migration 0033 —— 自動封存：project_settings + projects.unarchived_at
--   [6] migration 0034 + sql/0022 —— 合約／報價單與印花稅（模組四第 3 條）
--   [7] migration 0035 + sql/0023 —— 分期請款期程（模組四第 4 條）
--
-- 全部冪等，重複執行無害。
-- ⚠️ [3] 有一個前置檢查要先跑（既有專案若有重複編號，索引會建不起來）。
-- ⚠️ [4] 會轉換舊的 status='archived'，裡面有一筆「猜測」，請看該段說明。
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
-- [4] migration 0032 + sql/0021 —— 案情狀態與封存（模組四第 2 條）
-- ─────────────────────────────────────────────────────────────────
-- status（案情）與 archived_at（可見性）是兩軸。混成一欄的話，要封存一個
-- 已解約的案子就得把 terminated 覆寫掉，「這案子是解約收場」就沒了——
-- 而保留款收得到與收不到，差別就在這裡。
--
-- status_effective_on 是法律日期（解約通知書上的那天），
-- status_changed_at 是輸入時點。解約通知可能是上個月的，這週才進系統；
-- 解約日決定已完成部分的請款範圍與分期獎金的結算基準。

ALTER TABLE public.projects ADD COLUMN IF NOT EXISTS "status_reason" text;
ALTER TABLE public.projects ADD COLUMN IF NOT EXISTS "status_effective_on" date;
ALTER TABLE public.projects ADD COLUMN IF NOT EXISTS "status_changed_at" timestamp with time zone;
ALTER TABLE public.projects ADD COLUMN IF NOT EXISTS "status_changed_by_emp_id" uuid;
ALTER TABLE public.projects ADD COLUMN IF NOT EXISTS "archived_at" timestamp with time zone;

-- ── ⚠️ 舊資料轉換：這裡有一筆猜測 ────────────────────────────────
-- 舊制只有 active / archived 兩個值。archived 的專案**無從得知**它是
-- 正常結案還是中途解約——舊模型沒記。只能一律當結案並標記待補。
-- 跑完請用下面那條查詢把它們列出來人工確認。
UPDATE public.projects
   SET status = 'closed',
       archived_at = coalesce(archived_at, now()),
       status_reason = coalesce(status_reason,
         '由舊制「已封存」轉入，實際案情（結案／解約）待人工確認'),
       status_changed_at = coalesce(status_changed_at, now())
 WHERE status = 'archived';

-- 舊的 active 維持 active，不動。

-- 合法值防呆。舊資料轉完才能加，否則 archived 那些列會擋住。
ALTER TABLE public.projects DROP CONSTRAINT IF EXISTS projects_status_chk;
ALTER TABLE public.projects ADD CONSTRAINT projects_status_chk
  CHECK (status IN ('active', 'suspended', 'closed', 'terminated'));

-- ── 跑完之後：列出需要人工補案情的專案 ──────────────────────────
-- select id, code, name, status_reason
--   from public.projects
--  where status_reason like '由舊制%';

-- ─────────────────────────────────────────────────────────────────
-- [5] migration 0033 —— 自動封存（模組四第 2 條，使用者裁示「自動化」）
-- ─────────────────────────────────────────────────────────────────
-- 終止狀態（結案／已解約）滿 N 個月自動封存，N 可調（預設 6）。
--
-- **暫停永遠不自動封存**——暫停的案子最需要被看見，收起來就真的忘了，
-- 而忘掉的暫停案就是沒人去追的爛尾。
--
-- `unarchived_at`：有人特地把案子拉回來（多半在追尾款），排程當晚又把它
-- 收起來，這功能等於壞的。排程看這一欄放過該筆，直到案情再次變動。

CREATE TABLE IF NOT EXISTS "project_settings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"auto_archive_enabled" boolean DEFAULT true NOT NULL,
	"auto_archive_months" integer DEFAULT 6 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE public.projects ADD COLUMN IF NOT EXISTS "unarchived_at" timestamp with time zone;

DO $$ BEGIN
 ALTER TABLE "project_settings" ADD CONSTRAINT "project_settings_tenant_id_tenants_id_fk"
   FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id")
   ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS "project_settings_tenant_uq"
  ON "project_settings" USING btree ("tenant_id");

-- 參數改動要留痕（比照 expense_settings 已納入 sql/0019 的稽核清單）。
DROP TRIGGER IF EXISTS audit_all ON public.project_settings;
CREATE TRIGGER audit_all
  AFTER INSERT OR UPDATE OR DELETE ON public.project_settings
  FOR EACH ROW EXECUTE FUNCTION public.audit_row();

-- ── 排程 ────────────────────────────────────────────────────────────
-- 由 worker 每天 04:00（台北）呼叫 API 的
--   POST /internal/projects/auto-archive
-- 需要 worker 的 ENABLE_WORKER_SCHEDULERS=true 與 API 的
-- ENABLE_INTERNAL_JOBS=true / INTERNAL_JOB_TOKEN，與既有三支排程相同。

-- ─────────────────────────────────────────────────────────────────
-- [6] migration 0034 + sql/0022 —— 合約／報價單與印花稅（模組四第 3 條）
-- ─────────────────────────────────────────────────────────────────
-- 文件類型（合約／報價單／追加減帳）與我方角色（承攬人／定作人）**一起**
-- 決定課不課印花稅：
--   • 報價單不是契據（無雙方合意）→ 不課
--   • 承攬契據課千分之一，印花稅法 §7③ **由承攬人貼**
--     → 公司發包給下包的合約是下包在貼，不該算進我方應納稅額
--
-- 費率與試算稅額**凍結在合約列上**：清單要回溯 5～7 年，2021 年簽的約
-- 要用 2021 年的費率，不是今天設定的那個。
--
-- 回溯年數預設 **7** 不是客戶原文的 5：稅捐稽徵法 §21 未申報者核課期間
-- 7 年，而印花稅沒貼過花正是「未申報」——做 5 年會漏掉最需要清單的情形。

CREATE TABLE IF NOT EXISTS "contracts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"doc_type" text NOT NULL,
	"our_role" text DEFAULT 'contractor' NOT NULL,
	"title" text NOT NULL,
	"counterparty" text,
	"amount" numeric,
	"signed_on" date,
	"version" integer DEFAULT 1 NOT NULL,
	"supersedes_id" uuid,
	"copies" integer DEFAULT 1 NOT NULL,
	"stamp_duty_required" text DEFAULT 'auto' NOT NULL,
	"stamp_duty_rate" numeric,
	"stamp_duty_amount" numeric,
	"stamp_duty_paid_on" date,
	"stamp_duty_note" text,
	"created_by_emp_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"deleted_by_emp_id" uuid,
	"delete_reason" text
);

ALTER TABLE public.project_documents ADD COLUMN IF NOT EXISTS "contract_id" uuid;
ALTER TABLE public.project_settings ADD COLUMN IF NOT EXISTS "stamp_duty_rate" numeric DEFAULT '0.001' NOT NULL;
ALTER TABLE public.project_settings ADD COLUMN IF NOT EXISTS "stamp_duty_lookback_years" integer DEFAULT 7 NOT NULL;

DO $$ BEGIN
 ALTER TABLE "contracts" ADD CONSTRAINT "contracts_tenant_id_tenants_id_fk"
   FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id");
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
 ALTER TABLE "contracts" ADD CONSTRAINT "contracts_project_id_projects_id_fk"
   FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id");
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
 ALTER TABLE "project_documents" ADD CONSTRAINT "project_documents_contract_id_contracts_id_fk"
   FOREIGN KEY ("contract_id") REFERENCES "public"."contracts"("id");
EXCEPTION WHEN duplicate_object THEN null; END $$;

CREATE INDEX IF NOT EXISTS "contracts_project_idx" ON "contracts" USING btree ("tenant_id","project_id");
CREATE INDEX IF NOT EXISTS "contracts_signed_idx"  ON "contracts" USING btree ("tenant_id","signed_on");

-- ── sql/0022：禁刪 + 稽核 + 合法值防呆 ──────────────────────────────
-- 已貼花的合約被實體刪除，等於把「這筆稅貼過了」的證據一起刪掉，
-- 而印花稅核課期間最長 7 年，追徵時拿不出東西。
DROP TRIGGER IF EXISTS no_hard_delete ON public.contracts;
CREATE TRIGGER no_hard_delete
  BEFORE DELETE ON public.contracts
  FOR EACH ROW EXECUTE FUNCTION public.forbid_hard_delete();

DROP TRIGGER IF EXISTS audit_all ON public.contracts;
CREATE TRIGGER audit_all
  AFTER INSERT OR UPDATE OR DELETE ON public.contracts
  FOR EACH ROW EXECUTE FUNCTION public.audit_row();

ALTER TABLE public.contracts DROP CONSTRAINT IF EXISTS contracts_doc_type_chk;
ALTER TABLE public.contracts ADD CONSTRAINT contracts_doc_type_chk
  CHECK (doc_type IN ('contract', 'quotation', 'change_order'));

ALTER TABLE public.contracts DROP CONSTRAINT IF EXISTS contracts_our_role_chk;
ALTER TABLE public.contracts ADD CONSTRAINT contracts_our_role_chk
  CHECK (our_role IN ('contractor', 'client'));

ALTER TABLE public.contracts DROP CONSTRAINT IF EXISTS contracts_stamp_flag_chk;
ALTER TABLE public.contracts ADD CONSTRAINT contracts_stamp_flag_chk
  CHECK (stamp_duty_required IN ('auto', 'yes', 'no'));

-- ─────────────────────────────────────────────────────────────────
-- [7] migration 0035 + sql/0023 —— 分期請款期程（模組四第 4 條）
-- ─────────────────────────────────────────────────────────────────
-- 「輸入百分比後系統自動計算各期應收金額，嚴禁人工口算或 Excel 手動拉格」。
-- 痛點不是算不動，是加總對不起來：
--   合約 8,888,888 分 5 期每期 20% → 每期 1,777,778，五期合計 8,888,890
--   百分比合計剛好 100%，金額合計卻多 2 元。
-- → 最後一期＝合約總額 − 前面各期合計，總和才必然等於合約金額。
--
-- 分母＝我方承攬的合約 + 追加減帳（`contracts` 表，第 3 條）。
-- 已請款的期別凍結不重算；尾差落在最後一個未請款的期別。

CREATE TABLE IF NOT EXISTS "project_billings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"installment_no" integer NOT NULL,
	"percentage" numeric,
	"milestone" text,
	"planned_on" date,
	"calculated_amount" numeric,
	"residue_applied" numeric,
	"override_amount" numeric,
	"override_reason" text,
	"billed_on" date,
	"billed_amount" numeric,
	"note" text,
	"created_by_emp_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"deleted_by_emp_id" uuid,
	"delete_reason" text
);

DO $$ BEGIN
 ALTER TABLE "project_billings" ADD CONSTRAINT "project_billings_tenant_id_tenants_id_fk"
   FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id");
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
 ALTER TABLE "project_billings" ADD CONSTRAINT "project_billings_project_id_projects_id_fk"
   FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id");
EXCEPTION WHEN duplicate_object THEN null; END $$;

-- ⚠️ **必須是 partial index。** 把 deleted_at 當成索引欄位是錯的——
-- Postgres 視 NULL 互不相等，兩筆 deleted_at IS NULL 的列反而不會相撞，
-- 索引等於沒作用。
CREATE UNIQUE INDEX IF NOT EXISTS "project_billings_no_uq"
  ON "project_billings" USING btree ("tenant_id","project_id","installment_no")
  WHERE "project_billings"."deleted_at" is null;

-- ── sql/0023：禁刪 + 稽核 + 合法值防呆 ──────────────────────────────
-- 實體刪除一筆已請款的期別，等於讓那筆應收憑空消失，而對帳時只會看到
-- 「合計對不起來」卻查不出哪裡少了。
DROP TRIGGER IF EXISTS no_hard_delete ON public.project_billings;
CREATE TRIGGER no_hard_delete
  BEFORE DELETE ON public.project_billings
  FOR EACH ROW EXECUTE FUNCTION public.forbid_hard_delete();

DROP TRIGGER IF EXISTS audit_all ON public.project_billings;
CREATE TRIGGER audit_all
  AFTER INSERT OR UPDATE OR DELETE ON public.project_billings
  FOR EACH ROW EXECUTE FUNCTION public.audit_row();

ALTER TABLE public.project_billings DROP CONSTRAINT IF EXISTS project_billings_pct_chk;
ALTER TABLE public.project_billings ADD CONSTRAINT project_billings_pct_chk
  CHECK (percentage IS NULL OR (percentage >= 0 AND percentage <= 100));

-- 人工覆寫必須有理由：偏離期程的金額是談出來的，要留得下痕跡。
ALTER TABLE public.project_billings DROP CONSTRAINT IF EXISTS project_billings_override_chk;
ALTER TABLE public.project_billings ADD CONSTRAINT project_billings_override_chk
  CHECK (override_amount IS NULL OR override_reason IS NOT NULL);

-- billed_on 有值而 billed_amount 為空，對帳時會變成一筆看不見金額的應收。
ALTER TABLE public.project_billings DROP CONSTRAINT IF EXISTS project_billings_billed_chk;
ALTER TABLE public.project_billings ADD CONSTRAINT project_billings_billed_chk
  CHECK (billed_on IS NULL OR billed_amount IS NOT NULL);

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
--                                                                as "編號唯一索引(預期1)",
--   (select count(*) from information_schema.columns
--     where table_schema='public' and table_name='projects' and column_name in
--       ('status_reason','status_effective_on','status_changed_at',
--        'status_changed_by_emp_id','archived_at'))
--                                                                as "案情欄位(預期5)",
--   (select count(*) from public.projects where status='archived')
--                                                                as "殘留舊狀態(預期0)",
--   (select count(*) from information_schema.tables
--     where table_schema='public' and table_name='project_settings')
--                                                                as "project_settings(預期1)",
--   (select count(*) from information_schema.columns
--     where table_schema='public' and table_name='projects' and column_name='unarchived_at')
--                                                                as "unarchived_at(預期1)",
--   (select count(*) from information_schema.tables
--     where table_schema='public' and table_name='contracts')    as "contracts(預期1)",
--   (select count(*) from pg_trigger t
--      join pg_class c on c.oid=t.tgrelid
--      join pg_namespace n on n.oid=c.relnamespace
--     where n.nspname='public' and not t.tgisinternal and c.relname='contracts')
--                                                                as "contracts trigger(預期2)",
--   (select count(*) from information_schema.tables
--     where table_schema='public' and table_name='project_billings')
--                                                                as "project_billings(預期1)",
--   (select count(*) from pg_indexes
--     where schemaname='public' and indexname='project_billings_no_uq'
--       and indexdef like '%WHERE%')                             as "partial index(預期1)";

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
