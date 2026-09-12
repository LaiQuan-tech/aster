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
