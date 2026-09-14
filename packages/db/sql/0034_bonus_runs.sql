-- =====================================================================
-- 0034  D 批次：bonus_runs / bonus_run_items —— 專案獎金季發放批次凍結快照
--
-- 動機：專案獎金一季發放一次，每次發放要把當下的分潤試算結果凍結成
-- 不可覆蓋的快照，歷年可累計對比（同一員工在同一專案上，本季發放
-- =累計應得−歷史已發放，算法本身在應用層，這裡只管「凍結」這件事）。
--
-- 表結構（bonus_runs／bonus_run_items 兩張新表）由 drizzle migration 0045
-- 建立。本檔放 drizzle 管不了的四件事：CHECK 防呆、RLS、禁刪與稽核、
-- 已發放批次的凍結 trigger。比照 sql/0029（disbursements 新表同一套
-- RLS／禁刪／稽核／CHECK 做法）、sql/0030（子表依附母表狀態的刪除防呆）、
-- sql/0019（forbid_audit_mutation 的「僅 test/demo 租戶放行」escape
-- hatch 與 BEFORE UPDATE OR DELETE 共用一個函式的寫法）。
--
-- ── RLS：ENABLE 但不給 policy（比照 0024/0027/0028/0029/0033）───────
-- 前端不直接讀這兩張表，讀寫皆走 API 的 service_role（bypass RLS）。
--
-- ── 禁刪與稽核 ───────────────────────────────────────────────────────
--   • bonus_runs／bonus_run_items 皆掛 no_hard_delete＋audit_all（全量）：
--     發放批次與明細都是金額憑證，比照專案硬約束「經手金額的表一律稽核」
--     （sql/0019 檔頭）與模組二「禁止實體刪除」的精神。
--   • bonus_runs 另掛 set_updated_at（有 updated_at 欄位）；
--     bonus_run_items 無 updated_at 欄位（明細列建立後不就地改，同
--     disbursement_allocations 的理由），故不掛。
--
-- ── CHECK ────────────────────────────────────────────────────────────
--   • bonus_runs_status_chk：'draft' | 'paid'。
--   • bonus_runs_paid_requires_paid_on_chk：已發放（paid）就必須有發放日
--     （同 sql/0029 disbursements_paid_chk 的理由）。
--
-- ── forbid_paid_bonus_mutation()：paid 批次凍結，不可覆蓋 ────────────
-- 「凍結成不可覆蓋的快照」是本表存在的理由，只靠應用層擋不住——API 全程
-- 用 service_role key，BYPASS RLS（同 0018/0019 檔頭的理由），只有
-- trigger 對 service_role 仍然生效。
--
-- 一個函式服務兩張表（比照 forbid_hard_delete()／audit_row() 一個函式
-- 掛多張表的既有模式），用 TG_TABLE_NAME 分流：
--   • bonus_runs：查自己這列的 status。
--   • bonus_run_items：本身沒有 status，查所屬 run 的 status
--     （比照 sql/0030 forbid_delete_unless_draft_disbursement() 的
--     「SELECT 母表狀態」寫法，但這裡 UPDATE／DELETE 都要擋，不只 DELETE）。
-- status='paid' 時兩種操作（UPDATE／DELETE）一律 RAISE，結構與逃生口
-- 比照 sql/0019 forbid_audit_mutation()：BEFORE UPDATE OR DELETE 共用
-- 一個函式、用 TG_OP 決定 CASE 回傳值、僅 test/demo 租戶（
-- is_disposable_tenant，見 sql/0018）放行供整合測試清理已發放的測試資料。
--
-- 與 no_hard_delete 的關係（刻意重疊，非疏漏）：no_hard_delete 已經無條件
-- 擋掉正式租戶的 DELETE（不論 draft／paid），forbid_paid_bonus_mutation
-- 的 DELETE 判斷對正式租戶而言是重複的防線；但對 test/demo 租戶，
-- no_hard_delete 會放行 DELETE（不論 paid 與否），此時
-- forbid_paid_bonus_mutation 仍會先查一次 paid 狀態才放行——兩者用的是
-- 同一個 is_disposable_tenant() 判斷，實際行為一致，純粹是多一層明確表達
-- 「paid 批次不可變」這個規則本身（而不是依賴 no_hard_delete 的副作用），
-- 之後若 no_hard_delete 的判準改變，這條規則不會跟著鬆動。
--
-- 前提：sql/0018 forbid_hard_delete()／is_disposable_tenant()、sql/0019
-- audit_row()（sql/0033 已 CREATE OR REPLACE 成記操作者版本）、sql/0027
-- set_updated_at() 已存在；drizzle migration 0045 已套用（本檔用到的
-- 兩張新表皆由它建立）。
-- 套用方式：Supabase SQL Editor 或 Management API query 端點。
-- 冪等：CREATE OR REPLACE／DROP TRIGGER IF EXISTS＋CREATE／DROP CONSTRAINT
-- IF EXISTS＋ADD CONSTRAINT，可重複執行。
-- =====================================================================

-- ─────────────────────────────────────────────────────────────────────
-- [A] RLS：ENABLE，不給 policy
-- ─────────────────────────────────────────────────────────────────────
ALTER TABLE public.bonus_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.bonus_run_items ENABLE ROW LEVEL SECURITY;

-- ─────────────────────────────────────────────────────────────────────
-- [B] bonus_runs：禁刪＋稽核＋updated_at
-- ─────────────────────────────────────────────────────────────────────
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

-- ─────────────────────────────────────────────────────────────────────
-- [C] bonus_run_items：禁刪＋稽核（無 updated_at 欄位，不掛 set_updated_at）
-- ─────────────────────────────────────────────────────────────────────
DROP TRIGGER IF EXISTS no_hard_delete ON public.bonus_run_items;
CREATE TRIGGER no_hard_delete
  BEFORE DELETE ON public.bonus_run_items
  FOR EACH ROW EXECUTE FUNCTION public.forbid_hard_delete();

DROP TRIGGER IF EXISTS audit_all ON public.bonus_run_items;
CREATE TRIGGER audit_all
  AFTER INSERT OR UPDATE OR DELETE ON public.bonus_run_items
  FOR EACH ROW EXECUTE FUNCTION public.audit_row();

-- ─────────────────────────────────────────────────────────────────────
-- [D] 合法值防呆
-- ─────────────────────────────────────────────────────────────────────
ALTER TABLE public.bonus_runs DROP CONSTRAINT IF EXISTS bonus_runs_status_chk;
ALTER TABLE public.bonus_runs ADD CONSTRAINT bonus_runs_status_chk
  CHECK (status IN ('draft', 'paid'));

-- 已發放就必須有發放日（同 sql/0029 disbursements_paid_chk 的理由）。
ALTER TABLE public.bonus_runs DROP CONSTRAINT IF EXISTS bonus_runs_paid_requires_paid_on_chk;
ALTER TABLE public.bonus_runs ADD CONSTRAINT bonus_runs_paid_requires_paid_on_chk
  CHECK (status <> 'paid' OR paid_on IS NOT NULL);

-- ─────────────────────────────────────────────────────────────────────
-- [E] forbid_paid_bonus_mutation()：paid 批次凍結，不可覆蓋（見檔頭說明）
-- ─────────────────────────────────────────────────────────────────────
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

-- ── 還原（不可逆部分：新表刪除會連資料一起丟，先確認沒人用）────────────
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
-- （不 DISABLE RLS：一旦開了就該一直被擋住。新表本身的刪除留給 drizzle
-- migration 還原，這裡不重複列 DROP TABLE。）
