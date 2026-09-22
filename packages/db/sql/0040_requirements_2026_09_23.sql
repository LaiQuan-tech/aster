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
