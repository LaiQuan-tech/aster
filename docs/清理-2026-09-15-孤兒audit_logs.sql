-- =====================================================================
-- 亞斯特 — 2026-09-15 清理「租戶已不存在」的孤兒 audit_logs（一次性，非 migration）
--
-- ✅ 2026-09-20 已由業主在 SQL Editor 執行（當時 20,811 列／702 個租戶）。之後不需要再跑：
--    sql/0037 讓 forbid_audit_mutation 對「租戶列已不存在」的稽核列放行 DELETE，
--    並新增 purge_test_tenant()；整合測試的安全網（__tests__/setup.ts）每檔跑完會清掉
--    殘留的 test 租戶連同稽核列。本檔保留作紀錄。
--
-- 背景（C 批次驗收第 8 項順手發現）：整合測試的 afterAll 以前是
--   delete audit_logs → delete employees → delete tenants
-- 但 employees 自 sql/0031 起掛了 audit_all，刪員工會再寫 audit_logs；租戶接著被
-- 刪掉後，sql/0019 的 append-only trigger（forbid_audit_mutation → is_disposable_tenant
-- 查不到租戶回 false）就再也不放行 DELETE。截至 2026-09-15 01:30 UTC 以 service role
-- 經 PostgREST 統計：audit_logs 共 23,098 列，其中 17,206 列的 tenant_id 已不在 tenants
-- （626 個已刪的測試租戶；例：「分頁員工103…」那批 1,201 列、各 ~400 列的月表測試）。
-- 服務角色直接 DELETE 會被 trigger 擋（實測 SQLSTATE 23001），所以只能在 SQL Editor
-- 暫停 trigger 刪。測試順序已改（audit_logs 移到 employees 之後、tenants 之前），
-- 之後不會再累積。
--
-- ⚠️ 只刪「tenant_id 不在 tenants 表」的列；現存租戶（含正式租戶）的稽核軌跡一列不動。
--    tenant_id 為 null 的列（644 列，DB trigger 記不到租戶的系統操作）也不動。
-- ⚠️ 整段在同一交易內：DISABLE → DELETE → ENABLE，任何一句失敗整段回滾，trigger 不會
--    留在停用狀態。跑完請再跑最下面的確認查詢（預期 trigger 為 enabled、孤兒為 0）。
-- 套用方式：Supabase SQL Editor 整段貼上執行；或
--   npm run db:apply -- docs/清理-2026-09-15-孤兒audit_logs.sql
-- =====================================================================

-- ── 0. 套用前先看數量（唯讀）──────────────────────────────────────────
-- 預期：orphan_rows ≈ 17206、orphan_tenants ≈ 626（數字只會比 09-15 統計時多）
select count(*) as orphan_rows, count(distinct tenant_id) as orphan_tenants
  from public.audit_logs a
 where a.tenant_id is not null
   and not exists (select 1 from public.tenants t where t.id = a.tenant_id);

-- ── 1. 清理（同一交易）────────────────────────────────────────────────
begin;
alter table public.audit_logs disable trigger audit_logs_append_only;
delete from public.audit_logs a
 where a.tenant_id is not null
   and not exists (select 1 from public.tenants t where t.id = a.tenant_id);
alter table public.audit_logs enable trigger audit_logs_append_only;
commit;

-- ── 2. 套用後確認 ───────────────────────────────────────────────────
-- 預期 1 row：tgenabled = 'O'（origin，即啟用中）
select tgname, tgenabled from pg_trigger
 where tgrelid = 'public.audit_logs'::regclass and tgname = 'audit_logs_append_only';

-- 預期 orphan_rows = 0
select count(*) as orphan_rows
  from public.audit_logs a
 where a.tenant_id is not null
   and not exists (select 1 from public.tenants t where t.id = a.tenant_id);
