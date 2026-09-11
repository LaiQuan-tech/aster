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
--   ※ 若只要客戶明文那一組，刪掉下方第二個 FOREACH 區塊即可。
--
-- 套用方式：經 Supabase Management API query 端點（同 0001~0017）。
-- 冪等：DROP TRIGGER IF EXISTS 後重建，可重複執行。
-- 可逆：見檔末的還原指令。
-- =====================================================================

CREATE OR REPLACE FUNCTION public.forbid_hard_delete()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_status text;
BEGIN
  SELECT t.status INTO v_status
  FROM public.tenants t
  WHERE t.id = OLD.tenant_id;

  -- 測試／示範租戶放行（資料非證據）。
  IF v_status IN ('test', 'demo') THEN
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
    'payslips'
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
--     'approval_steps','announcements','punch_records','attendance_days','payslips']
--   LOOP EXECUTE format('DROP TRIGGER IF EXISTS no_hard_delete ON public.%I', t); END LOOP;
-- END $$;
-- DROP FUNCTION IF EXISTS public.forbid_hard_delete();
