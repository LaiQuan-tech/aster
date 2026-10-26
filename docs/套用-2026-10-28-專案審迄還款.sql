-- =====================================================================
-- 2026-10-28 專案申請單「審迄還款」（migration 0077 ＝ sql/0067）
--
-- 前提：已套到 0076（sql/0066，docs/套用-2026-10-27-客供商欄位.sql）。整份可重跑（冪等），包在 BEGIN／COMMIT 交易裡（一錯全回滾）。
-- 套用後跑 docs/驗證-2026-10-28-專案審迄還款.sql。
-- 順序：先套本檔或先部署皆可——API 會探測 projects.guild_repayment_note：沒套時 GET 回 null、
--   申請單上該格存檔回 409 migration_required（其他欄位照常可存）。建議先套本檔再部署。
-- 已用 `npm run db:replay -- --base-migration 53 --base-sql 62
--   --base-file docs/套用-2026-10-26-專案分潤毛利與核准.sql --base-file docs/套用-2026-10-26-打卡冪等.sql
--   --base-file docs/套用-2026-10-27-專案各角色分潤趴數.sql --base-file docs/套用-2026-10-27-客供商欄位.sql
--   --seed docs/test/replay-seed-2026-10-28-guild-repayment.sql docs/套用-2026-10-28-專案審迄還款.sql
--   --verify docs/驗證-2026-10-28-專案審迄還款.sql` 在 pglite 上重放兩次（每次內含套兩遍驗冪等）全部通過。
--   （base 說明：migration 0054 起每支都有內容相同的 sql/00NN-10，而 0058 起依賴 sql/0019 的 audit_row()，
--    所以 base 用 migrations ≤0053＋sql ≤0062，0073～0076 改用當時實際套用的合併檔重建。）
-- =====================================================================

BEGIN;

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

COMMIT;
