-- 2026-11-02 MCP 待確認操作對象摘要（migration 0084 ＝ sql/0074）。前提：已套 0083。冪等、包在交易內。
-- 套用後跑 docs/驗證-2026-11-02-MCP待確認對象摘要.sql。
BEGIN;

-- 2026-11-02 MCP 待確認操作：存「對象摘要」（資安複驗 N1）。
-- 建立待確認時 API 把路徑中的 id 解析成人可讀摘要（員工姓名／編號、放款單號＋金額＋受款人、期間、獎金批次、專案…），
-- 確認頁最上方顯示；解析不到存 null，確認頁顯示「無法辨識對象，請小心」。
-- 前提：已套 0083（sql/0073）。可重跑。
ALTER TABLE public.mcp_pending_actions ADD COLUMN IF NOT EXISTS target_summary text;

COMMIT;
