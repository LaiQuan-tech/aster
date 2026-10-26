-- 2026-10-28 專案申請單「審迄還款」：Word 申請單付款階段第 8 列（技師公會代墊）右側「審迄還款:」格，
-- 業主決定系統要有這一欄。
--   projects.guild_repayment_note  text  可空。自由文字（例：「115.9.30 已還」、日期加金額）：
--     Word 原檔該格是單一空白格（與同欄「發票號碼:」格同寬，那格實際填「號碼＋日期」），
--     沒有固定格式，所以存文字、不拆日期／金額兩欄。長度上限 200（與 API 相同）。
-- 寫入一律經 API（PATCH /projects/:id，權限同付款方式等申請單欄位：canManage）；不新增直接寫入 policy，
-- 讀取 policy 不動；audit trigger 整列 to_jsonb，新欄位自動入稽核。
-- 前提：已套到 0076（sql/0066）。可重跑（IF NOT EXISTS／DROP … IF EXISTS）。
-- 欄位沒套時 API 降級：GET 回 null、PATCH 帶 guildRepaymentNote 回 409 migration_required。

ALTER TABLE public.projects ADD COLUMN IF NOT EXISTS guild_repayment_note text;

ALTER TABLE public.projects DROP CONSTRAINT IF EXISTS projects_guild_repayment_note_len_chk;
ALTER TABLE public.projects ADD CONSTRAINT projects_guild_repayment_note_len_chk
  CHECK (guild_repayment_note IS NULL OR char_length(guild_repayment_note) <= 200);

COMMENT ON COLUMN public.projects.guild_repayment_note IS '專案申請單付款階段「技師公會代墊」列的「審迄還款」（自由文字，≤200 字；2026-10-28）';
