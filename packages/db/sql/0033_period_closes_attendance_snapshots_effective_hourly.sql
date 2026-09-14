-- =====================================================================
-- 0033  C 批次：audit_row() 記操作者／規則生效日 backfill／
--       月結＋月表快照新表／時薪制 CHECK
--
-- 表結構（rule_configs.effective_from、salary_adjustments.changed_by_emp_id、
-- salary_structures 兩個 agreed_*_per_week 欄位、period_closes／
-- attendance_sheet_snapshots 兩張新表）由 drizzle migration 0044 建立。
-- 本檔放 drizzle 管不了的五件事：audit_row() 改版、既有表補掛 audit trigger、
-- 資料 backfill、CHECK 防呆、storage bucket。
--
-- ── [A] audit_row() 改版：記操作者 ───────────────────────────────────
-- 已在正式庫實測：PostgREST 會把請求 header 放進 GUC `request.headers`
-- （JSON，key 小寫）。trigger 內用
-- `current_setting('request.headers', true)::json ->> 'x-actor-emp-id'`
-- 讀得到呼叫端夾帶的 header，因此 DB trigger 現在也能記下「誰改的」，不必
-- 再完全依賴應用層 `services/audit.ts` 的 writeAuditLog（見 0019 檔頭與
-- audit-logs.ts schema 註解的兩來源說明；此改版後兩者仍會並存，查核仍以
-- (table_name, record_id) 拼看）。
--
-- CREATE OR REPLACE，其餘邏輯（v_old/v_new/v_any 判斷、RETURN NULL）照
-- 0019 一字不改，只新增：
--   • DECLARE 多兩個變數 v_actor uuid、v_ctx text；
--   • BEGIN 內一個子區塊，用 EXCEPTION WHEN others 吃掉任何解析失敗
--     （GUC 不存在、值不是合法 JSON、值不是合法 uuid 等）退回 null——
--     **絕不能因稽核讓業務寫入失敗**；
--   • INSERT 的欄位與值多帶 actor_emp_id、context 兩欄（0019 原本的 INSERT
--     欄位清單裡完全沒有這兩欄，即预設 null，故此處不需要 coalesce 任何
--     既有值，直接帶入 v_actor／v_ctx 即可）。
--
-- ── [B] 既有表補掛 audit trigger ─────────────────────────────────────
-- 先 grep 現況（見 PR 說明），只補真的沒掛的：employee_profiles、
-- departments、tenants、shifts、schedules、tenant_calendar_days、
-- approval_flows、expense_settings 補 audit_all；onboardings 補
-- audit_mutations（只 UPDATE/DELETE——比照 0019 對 punch_records/
-- attendance_days 的判準，onboardings 是任用流程的單頭，INSERT
-- 本身沒有「竄改」疑慮，UPDATE/DELETE 才需要留痕）。
-- employees（0031）、leave_types（0032）、project_settings／contracts
-- （0022）、project_billings（0023）、vendors（0025）、attendance_sheets
-- （0027）、project_subcontracts／project_subcontract_payments／clients／
-- companies（0028）、salary_adjustments（0019 原始清單即含）皆已掛過，
-- 本檔不重複宣告。
--
-- ── [C] rule_configs.effective_from backfill ─────────────────────────
-- 新欄位 DEFAULT '1900-01-01'（刻意選的哨兵值，早於任何真實資料）。
-- 既有列改填 `(created_at at time zone 'Asia/Taipei')::date`
-- （租戶目前皆為 Asia/Taipei，同出勤模組換算慣例）。只對仍是 1900-01-01
-- 的列動手，重跑冪等：已經 backfill 過的列不會再符合 WHERE 條件。
--
-- ── [D] salary_structures.method CHECK ───────────────────────────────
-- 先確認現值集合：DB 層原本完全沒有 CHECK（grep 遍 migrations／sql 皆無
-- 相符約束），只有應用層 zod enum（apps/api/src/routes/salary.ts）限制在
-- 'monthly'／'by_attendance_days'（預設 'monthly'，見
-- packages/db/src/schema/salary-structures.ts 原註解）。本檔新增
-- salary_structures_method_chk，非「修改既有的」，集合納入新值 'hourly'
-- （工讀生時薪制）。
--
-- ── [E] period_closes／attendance_sheet_snapshots ────────────────────
-- 比照 sql/0027（新表禁刪＋稽核＋updated_at＋CHECK）、sql/0029（RLS＋
-- 禁刪／稽核取捨＋storage bucket）的既有做法：
--   • 兩張新表：ENABLE RLS、不給 policy（前端不直讀，皆走 API service_role）。
--   • 兩張新表皆 no_hard_delete：都是稽核/備份性質的紀錄，不該被刪除。
--   • period_closes 另掛 set_updated_at（有 updated_at 欄位）與 audit_all
--     （月結本身的建立/覆蓋屬於需要留痕的操作）。
--   • attendance_sheet_snapshots **不**掛 audit_all：這張表自己就是快照
--     歷史紀錄（無 updated_at 欄位、本來就不可就地改，no_hard_delete 已擋
--     刪除），再疊一層 audit_all 只是稽核自己，沒有新資訊（同 audit_logs
--     不稽核自己、改用 forbid_audit_mutation 把關的理由）。
--   • period_closes_status_chk：'closed' | 'reopened'。
--
-- ── [F] storage bucket tenant-snapshots ──────────────────────────────
-- 比照 sql/0020／0029：private（public=false）。月結產生的快照清單檔／
-- 匯出檔放這裡，讀取一律走短效期 signed URL，不加 anon 可讀 policy。
--
-- 前提：sql/0018 forbid_hard_delete()、sql/0019 audit_row()、sql/0027
-- set_updated_at() 已存在；drizzle migration 0044 已套用（本檔用到的欄位
-- 與兩張新表皆由它建立）。
-- 套用方式：Supabase SQL Editor 或 Management API query 端點。
-- 冪等：CREATE OR REPLACE／DROP TRIGGER IF EXISTS＋CREATE／DROP CONSTRAINT
-- IF EXISTS＋ADD CONSTRAINT／ON CONFLICT DO NOTHING／backfill 的 WHERE
-- 條件收斂，可重複執行。
-- =====================================================================

-- ─────────────────────────────────────────────────────────────────────
-- [A] audit_row() 改版：記操作者（actor_emp_id／context 讀 PostgREST
-- request.headers GUC）
-- ─────────────────────────────────────────────────────────────────────
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
  v_actor uuid;
  v_ctx text;
BEGIN
  BEGIN
    v_actor := nullif(current_setting('request.headers', true)::json ->> 'x-actor-emp-id', '')::uuid;
    v_ctx := nullif(current_setting('request.headers', true)::json ->> 'x-actor-route', '');
  EXCEPTION WHEN others THEN
    v_actor := null;
    v_ctx := null;
  END;

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
    (tenant_id, table_name, record_id, action, old_row, new_row, db_user, actor_emp_id, context)
  VALUES (
    nullif(v_any ->> 'tenant_id', '')::uuid,
    TG_TABLE_NAME,
    nullif(v_any ->> 'id', '')::uuid,
    TG_OP,
    v_old,
    v_new,
    current_user,
    v_actor,
    v_ctx
  );

  RETURN NULL; -- AFTER trigger，回傳值不被使用
END;
$$;

COMMENT ON FUNCTION public.audit_row() IS
  '把一列的 INSERT/UPDATE/DELETE 寫進 audit_logs（整列 jsonb）。C 批次起 actor_emp_id／context 優先讀 PostgREST 的 request.headers GUC（x-actor-emp-id／x-actor-route，已於正式庫實測可行）；GUC 不存在或值不合法時（migration／psql／pglite 等非 PostgREST 路徑）兩者皆為 null，不影響業務寫入（見 EXCEPTION WHEN others）。應用層 writeAuditLog 仍可能另外補一列，查核以 (table_name, record_id) 拼看。';

-- ─────────────────────────────────────────────────────────────────────
-- [B] 既有表補掛 audit trigger（只補確認沒掛過的）
-- ─────────────────────────────────────────────────────────────────────
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'employee_profiles',
    'departments',
    'tenants',
    'shifts',
    'schedules',
    'tenant_calendar_days',
    'approval_flows',
    'expense_settings'
  ]
  LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS audit_all ON public.%I', t);
    EXECUTE format(
      'CREATE TRIGGER audit_all AFTER INSERT OR UPDATE OR DELETE ON public.%I '
      'FOR EACH ROW EXECUTE FUNCTION public.audit_row()', t);
  END LOOP;
END $$;

-- onboardings：任用流程單頭，只稽核異動（同 0019 對 punch_records/attendance_days 的判準）。
DROP TRIGGER IF EXISTS audit_mutations ON public.onboardings;
CREATE TRIGGER audit_mutations
  AFTER UPDATE OR DELETE ON public.onboardings
  FOR EACH ROW EXECUTE FUNCTION public.audit_row();

-- ─────────────────────────────────────────────────────────────────────
-- [C] rule_configs.effective_from backfill（只動仍是預設哨兵值的列）
-- ─────────────────────────────────────────────────────────────────────
UPDATE public.rule_configs
   SET effective_from = (created_at AT TIME ZONE 'Asia/Taipei')::date
 WHERE effective_from = '1900-01-01';

-- ─────────────────────────────────────────────────────────────────────
-- [D] salary_structures.method 合法值防呆（新增，DB 層原本無 CHECK）
-- ─────────────────────────────────────────────────────────────────────
ALTER TABLE public.salary_structures DROP CONSTRAINT IF EXISTS salary_structures_method_chk;
ALTER TABLE public.salary_structures ADD CONSTRAINT salary_structures_method_chk
  CHECK (method IN ('monthly', 'by_attendance_days', 'hourly'));

-- ─────────────────────────────────────────────────────────────────────
-- [E] period_closes／attendance_sheet_snapshots：RLS＋禁刪／稽核取捨＋
-- updated_at＋CHECK
-- ─────────────────────────────────────────────────────────────────────
ALTER TABLE public.period_closes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.attendance_sheet_snapshots ENABLE ROW LEVEL SECURITY;

-- period_closes：月結紀錄，禁刪＋稽核＋updated_at。
DROP TRIGGER IF EXISTS no_hard_delete ON public.period_closes;
CREATE TRIGGER no_hard_delete
  BEFORE DELETE ON public.period_closes
  FOR EACH ROW EXECUTE FUNCTION public.forbid_hard_delete();

DROP TRIGGER IF EXISTS audit_all ON public.period_closes;
CREATE TRIGGER audit_all
  AFTER INSERT OR UPDATE OR DELETE ON public.period_closes
  FOR EACH ROW EXECUTE FUNCTION public.audit_row();

DROP TRIGGER IF EXISTS set_updated_at ON public.period_closes;
CREATE TRIGGER set_updated_at
  BEFORE UPDATE ON public.period_closes
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.period_closes DROP CONSTRAINT IF EXISTS period_closes_status_chk;
ALTER TABLE public.period_closes ADD CONSTRAINT period_closes_status_chk
  CHECK (status IN ('closed', 'reopened'));

-- attendance_sheet_snapshots：只禁刪，不稽核（本身就是快照歷史，見檔頭 [E] 說明）。
DROP TRIGGER IF EXISTS no_hard_delete ON public.attendance_sheet_snapshots;
CREATE TRIGGER no_hard_delete
  BEFORE DELETE ON public.attendance_sheet_snapshots
  FOR EACH ROW EXECUTE FUNCTION public.forbid_hard_delete();

-- =====================================================================
-- storage bucket：tenant-snapshots（月結／快照匯出檔，比照 sql/0020／0029）
--
-- private（public = false）：月結快照涉及薪資與出勤個資，不可公開讀取。
-- API 以 service_role 上傳，讀取一律走短效期 signed URL。RLS：
-- storage.objects 預設啟用且無 policy＝一律拒絕，service_role 繞過 RLS，
-- 前端 anon key 讀不到——不要為了「方便」加 anon 可讀的 policy。
-- =====================================================================
insert into storage.buckets (id, name, public)
values ('tenant-snapshots', 'tenant-snapshots', false)
on conflict (id) do nothing;

update storage.buckets
   set public = false
 where id = 'tenant-snapshots'
   and public is distinct from false;

-- ── 還原 ────────────────────────────────────────────────────────────
-- delete from storage.objects where bucket_id = 'tenant-snapshots';
-- delete from storage.buckets where id = 'tenant-snapshots';
-- DROP TRIGGER IF EXISTS no_hard_delete ON public.attendance_sheet_snapshots;
-- ALTER TABLE public.period_closes DROP CONSTRAINT IF EXISTS period_closes_status_chk;
-- DROP TRIGGER IF EXISTS set_updated_at ON public.period_closes;
-- DROP TRIGGER IF EXISTS audit_all ON public.period_closes;
-- DROP TRIGGER IF EXISTS no_hard_delete ON public.period_closes;
-- ALTER TABLE public.salary_structures DROP CONSTRAINT IF EXISTS salary_structures_method_chk;
-- （rule_configs.effective_from 的 backfill 不可逆——還原不出原本「沒有生效日」這個狀態。）
-- DROP TRIGGER IF EXISTS audit_mutations ON public.onboardings;
-- DO $$ DECLARE t text; BEGIN
--   FOREACH t IN ARRAY ARRAY['employee_profiles','departments','tenants','shifts',
--     'schedules','tenant_calendar_days','approval_flows','expense_settings']
--   LOOP EXECUTE format('DROP TRIGGER IF EXISTS audit_all ON public.%I', t); END LOOP;
-- END $$;
-- （audit_row() 一旦改版不建議還原成舊版——舊版拿掉的是「記操作者」這個能力，
-- 且新版對舊行為完全相容（GUC 不存在時 actor_emp_id／context 皆為 null，
-- 等同舊版行為）；如真要回退，把本檔 [A] 換回 sql/0019 的原始定義即可。）
-- （新表 period_closes／attendance_sheet_snapshots 本身的刪除留給 drizzle
-- migration 還原，這裡不重複列 DROP TABLE：刪表會連資料一起丟，先確認沒人用。）
