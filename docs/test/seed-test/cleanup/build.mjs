/**
 * build.mjs — 把五個清理片段組成「一次可執行」的 DO block。
 *
 *   node docs/test/seed-test/cleanup/build.mjs            → 寫出 docs/test/清理-後台測試資料.sql
 *   node docs/test/seed-test/cleanup/build.mjs --dry-run  → 同上但結尾 RAISE EXCEPTION，整包回滾
 *                                                          （拿去 Management API／SQL Editor 跑，
 *                                                          看到 DRY_RUN_ROLLBACK 就代表每一句都能過）
 *
 * 順序（子表先、父表後；理由寫在各片段檔頭）：
 *   30-payroll → 20-attendance → 10-finance → 40-people → 00-base
 *   payroll 的 expense_claims 綁 advances／出差單，所以要先於 attendance；
 *   attendance／finance／people 都掛在測試員工身上，所以 base（刪 employees）最後。
 *
 * ⚠️ Storage 檔（憑證／文件／附件／收據）不在 SQL 裡：先跑 cleanup/storage.mjs 再跑這份 SQL
 *    （storage.mjs 要從 DB 讀 storage_path，DB 先清就找不到路徑了）。
 */
import { readFileSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const here = dirname(fileURLToPath(import.meta.url))
const ORDER = ["30-payroll.sql", "20-attendance.sql", "10-finance.sql", "40-people.sql", "00-base.sql"]
const TENANT = "0507ad78-27f4-480e-b99f-a72db2aee50c"
const dry = process.argv.includes("--dry-run")
const outPath = process.argv.find((a) => a.startsWith("--out="))?.slice(6)
  ?? resolve(here, dry ? "../../清理-後台測試資料.dry-run.sql" : "../../清理-後台測試資料.sql")

const stripHeader = (sql) => {
  // 片段檔頭是一整塊「-- ===」包起來的說明，執行時不需要；保留本文（含行內註解）
  const lines = sql.split("\n")
  let i = 0
  if (lines[0]?.startsWith("-- ====")) {
    i = 1
    while (i < lines.length && !lines[i].startsWith("-- ====")) i++
    i++
  }
  return lines.slice(i).join("\n").trim()
}

const parts = ORDER.map((f) => {
  const body = stripHeader(readFileSync(join(here, f), "utf8"))
  return `  -- ───────────────────────── ${f} ─────────────────────────\n` +
    body.split("\n").map((l) => (l ? `  ${l}` : l)).join("\n")
})

const sql = `-- =====================================================================
-- 亞斯特 — 清除 2026-09-22 建立的後台【測試】資料（由 docs/test/seed-test/cleanup/build.mjs 產生${dry ? "；DRY-RUN 版，結尾整包回滾" : ""}）
--
-- 用途：業主驗完後台功能後，一次刪光 docs/test/seed-test/*.mjs 灌進正式租戶的測試資料：
--   三位【測試】測試員工 A/B/C（含登入帳號）＋【測試】報到者C、測試部與子組、假別／班別／行事曆／
--   內部連結、專案／合約／期款／副委託／放款／獎金批次／客戶／廠商／公司主體、排班／打卡／出勤日／
--   月表／假單／簽核／餘額／預支／補休、薪資結構／薪資單／調薪／眷屬／非員工所得／費用類別／報銷／月結、
--   報到／招募／考核／專屬信箱／公告／公司資訊頁／知識庫，以及掛在測試員工或提到【測試】的通知。
-- 不動：真實員工與他們的任何資料、audit_logs（稽核保留）、Storage 備份快照（tenant-snapshots）。
-- 前置：先跑 \`node docs/test/seed-test/cleanup/storage.mjs\` 刪 Storage 檔（它要先從 DB 讀路徑）。
-- 執行：Supabase Management API query 端點或 SQL Editor（單一交易，任何一句失敗整包回滾）。
-- 冪等：可重複執行（第二次全部 0 列）。
-- =====================================================================

DO $$
DECLARE
  t        uuid := '${TENANT}';
  test_emp uuid[];
BEGIN
  IF (SELECT status FROM public.tenants WHERE id = t) <> 'active' THEN
    RAISE EXCEPTION 'tenant % is not active (status=%)', t, (SELECT status FROM public.tenants WHERE id = t);
  END IF;
  -- 測試員工＝名字以【測試】開頭（三位有帳號的 A/B/C ＋ 報到完成產生的無帳號報到者C）
  SELECT COALESCE(array_agg(id), '{}') INTO test_emp
    FROM public.employees WHERE tenant_id = t AND name LIKE '【測試】%';
  RAISE NOTICE 'test employees: %', COALESCE(array_length(test_emp, 1), 0);

  -- sql/0018 forbid_hard_delete／0034 forbid_paid_bonus_mutation／0019 audit append-only
  -- 只對 status IN ('test','demo') 的租戶放行實體刪除：同一交易內切 demo → 刪 → 切回 active。
  UPDATE public.tenants SET status = 'demo' WHERE id = t;

${parts.join("\n\n")}

  UPDATE public.tenants SET status = 'active' WHERE id = t;
${dry ? `
  -- 乾跑：把「刪完後還剩多少【測試】相關列」塞進例外訊息（Management API 看不到 NOTICE）
  DECLARE
    leftover text;
  BEGIN
    SELECT string_agg(k || '=' || v, ', ') INTO leftover FROM (
      SELECT 'employees' k, count(*)::text v FROM public.employees WHERE tenant_id = t AND name LIKE '【測試】%'
      UNION ALL SELECT 'auth_users', count(*)::text FROM auth.users WHERE email LIKE '%@test.aster.local'
      UNION ALL SELECT 'departments', count(*)::text FROM public.departments WHERE tenant_id = t AND name LIKE '【測試】%'
      UNION ALL SELECT 'projects', count(*)::text FROM public.projects WHERE tenant_id = t AND name LIKE '【測試】%'
      UNION ALL SELECT 'disbursements', count(*)::text FROM public.disbursements WHERE tenant_id = t AND purpose LIKE '【測試】%'
      UNION ALL SELECT 'bonus_runs', count(*)::text FROM public.bonus_runs WHERE tenant_id = t AND label LIKE '【測試】%'
      UNION ALL SELECT 'clients', count(*)::text FROM public.clients WHERE tenant_id = t AND name LIKE '【測試】%'
      UNION ALL SELECT 'vendors', count(*)::text FROM public.vendors WHERE tenant_id = t AND name LIKE '【測試】%'
      UNION ALL SELECT 'companies', count(*)::text FROM public.companies WHERE tenant_id = t AND name LIKE '【測試】%'
      UNION ALL SELECT 'leave_requests_test_emp', count(*)::text FROM public.leave_requests WHERE tenant_id = t AND employee_id = ANY(test_emp)
      UNION ALL SELECT 'punch_records_test_emp', count(*)::text FROM public.punch_records WHERE tenant_id = t AND employee_id = ANY(test_emp)
      UNION ALL SELECT 'payslips_test_emp', count(*)::text FROM public.payslips WHERE tenant_id = t AND employee_id = ANY(test_emp)
      UNION ALL SELECT 'expense_claims_test_emp', count(*)::text FROM public.expense_claims WHERE tenant_id = t AND employee_id = ANY(test_emp)
      UNION ALL SELECT 'advances_test_emp', count(*)::text FROM public.advances WHERE tenant_id = t AND employee_id = ANY(test_emp)
      UNION ALL SELECT 'announcements', count(*)::text FROM public.announcements WHERE tenant_id = t AND title LIKE '【測試】%'
      UNION ALL SELECT 'knowledge_documents', count(*)::text FROM public.knowledge_documents WHERE tenant_id = t AND title LIKE '【測試】%'
      UNION ALL SELECT 'notifications_test', count(*)::text FROM public.notifications WHERE tenant_id = t AND (employee_id = ANY(test_emp) OR title LIKE '%【測試】%')
      UNION ALL SELECT 'leave_types', count(*)::text FROM public.leave_types WHERE tenant_id = t AND code LIKE 'test\\_%'
      UNION ALL SELECT 'shifts', count(*)::text FROM public.shifts WHERE tenant_id = t AND name LIKE '【測試】%'
      UNION ALL SELECT 'real_employees', count(*)::text FROM public.employees WHERE tenant_id = t AND name NOT LIKE '【測試】%'
      UNION ALL SELECT 'real_leave_requests', count(*)::text FROM public.leave_requests WHERE tenant_id = t AND NOT (employee_id = ANY(test_emp))
      UNION ALL SELECT 'real_punch_records', count(*)::text FROM public.punch_records WHERE tenant_id = t AND NOT (employee_id = ANY(test_emp))
    ) x;
    RAISE EXCEPTION 'DRY_RUN_ROLLBACK（全部語句都能執行，這裡故意回滾）leftover: %', leftover;
  END;
` : ""}END $$;
`
writeFileSync(outPath, sql)
console.log(`${dry ? "[dry-run] " : ""}wrote ${outPath} (${sql.split("\n").length} lines)`)
