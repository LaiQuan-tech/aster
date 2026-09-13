-- =====================================================================
-- 0024  API 專用表一律啟用 RLS（不給 policy ＝ anon/authenticated 全擋）
--
-- 背景（2026-09-14 正式庫 vs repo 比對抓到）：
--   • 模組三、四建的 5 張表（advances、contracts、expense_settings、
--     project_billings、project_settings）RLS 是**關的**。public schema 被
--     PostgREST 曝露、anon/authenticated 對 public 表有完整 grant，等於拿前端
--     bundle 裡的 anon key 就能直接讀寫所有租戶的合約、請款、預支。
--   • 另外 8 張表（announcement_* 3 張、audit_logs、expense_* 4 張）正式庫上 RLS
--     已開但 repo 沒有任何一份 SQL 這樣做——是有人在 Supabase 後台手動開的。
--     repo 必須能重建正式庫，所以這裡一併記下來。
--
-- 做法：比照 0001 對 tenants 的處理——ENABLE ROW LEVEL SECURITY、不給 policy。
--   前端從不直接讀表（apps/web 沒有任何 .from()），所有讀寫都經 API 的
--   service_role（bypass RLS），所以「全擋」不影響功能；這些表是金流、憑證、
--   稽核與租戶設定，沒有理由讓 anon key 碰得到。日後若真要讓前端直讀，再依
--   0016 的 GROUP B（本人或 HR 可讀、HR 可寫）補 policy。
--
-- 冪等，可重複執行。行為實測見 docs/驗證-RLS行為實測.sql。
-- =====================================================================

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    -- 模組三、四（2026-09-14 補開）
    'advances', 'contracts', 'expense_settings', 'project_billings', 'project_settings',
    -- 正式庫已開、repo 補記
    'announcement_versions', 'announcement_signature_sheets', 'announcement_acknowledgements',
    'audit_logs',
    'expense_categories', 'expense_claims', 'expense_claim_attachments', 'expense_settlements'
  ] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
  END LOOP;
END $$;

-- ── 驗證：public 下不該再有 RLS 關著的表 ────────────────────────────
-- select relname from pg_class
--  where relnamespace='public'::regnamespace and relkind='r' and not relrowsecurity;
-- → 預期 0 列
