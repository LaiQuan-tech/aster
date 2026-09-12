-- =====================================================================
-- 0021  專案案情狀態：舊資料轉換 + 合法值防呆（模組四第 2 條）
--
-- 欄位本身由 drizzle migration 0032 建立。本檔放的是 drizzle 管不了的
-- 兩件事：**有順序相依的資料轉換**，與需要在轉換後才能加的 CHECK。
--
-- ── 為何 CHECK 不寫進 drizzle schema ───────────────────────────────
-- 若寫在 schema 裡，migration 會在既有 status='archived' 的資料上直接失敗。
-- 資料轉換必須先跑，CHECK 才能加，而 drizzle migration 無法表達這個順序。
-- 比照 sql/0018~0020 的做法：有順序相依的 DB 物件放這裡。
--
-- ── ⚠️ 這裡有一筆猜測 ─────────────────────────────────────────────
-- 舊制只有 active / archived。archived 的專案**無從得知**它是正常結案
-- 還是中途解約——舊模型沒記這件事。只能一律當結案並標記待人工確認。
-- 套用後請跑檔末的查詢把它們列出來補。
--
-- 套用方式：Supabase SQL Editor。
-- 冪等：可重複執行。
-- =====================================================================

-- ── 舊資料轉換 ──────────────────────────────────────────────────────
UPDATE public.projects
   SET status = 'closed',
       archived_at = coalesce(archived_at, now()),
       status_reason = coalesce(status_reason,
         '由舊制「已封存」轉入，實際案情（結案／解約）待人工確認'),
       status_changed_at = coalesce(status_changed_at, now())
 WHERE status = 'archived';

-- 舊的 active 維持 active，不動。

-- ── 合法值防呆 ──────────────────────────────────────────────────────
-- 狀態集合刻意寫死不做成設定表：一旦可自訂，「哪些狀態算終止」就寫不死，
-- 之後請款的 gating 要跟著可設定。彈性由 status_reason 自由填吸收。
ALTER TABLE public.projects DROP CONSTRAINT IF EXISTS projects_status_chk;
ALTER TABLE public.projects ADD CONSTRAINT projects_status_chk
  CHECK (status IN ('active', 'suspended', 'closed', 'terminated'));

-- ── 套用後：列出需要人工補案情的專案 ────────────────────────────────
--   select id, code, name, status_reason
--     from public.projects
--    where status_reason like '由舊制%';

-- ── 還原 ────────────────────────────────────────────────────────────
-- ALTER TABLE public.projects DROP CONSTRAINT IF EXISTS projects_status_chk;
-- （資料轉換不可逆——舊制沒記結案或解約，轉回去也還原不出原本的資訊。）
