/**
 * build.mjs — 把六個清理片段組成「一次可執行」的 DO block：清除「萊乾資訊以外」的後台【測試】資料。
 *
 *   node docs/test/seed-test/cleanup/build.mjs            → 寫出 docs/test/清理-後台測試資料.sql
 *   node docs/test/seed-test/cleanup/build.mjs --dry-run  → 同上但結尾 RAISE EXCEPTION，整包回滾
 *                                                          （拿去 Management API／SQL Editor 跑，
 *                                                          看到 DRY_RUN_ROLLBACK 就代表每一句都能過，
 *                                                          訊息裡有各表刪除筆數與保護檢查結果）
 *
 * 順序（子表先、父表後；理由寫在各片段檔頭）：
 *   50-requirements → 30-payroll → 20-attendance → 10-finance → 40-people → 00-base
 *   payroll 的 expense_claims 綁 advances／出差單，所以要先於 attendance；
 *   attendance／finance／people 都掛在測試員工身上，所以 base（刪 employees）最後。
 *
 * 保留萊乾資訊與測試同仁 B（2026-09-30 業主要求「後台只留萊乾資訊的測試資料」，另留 T002【測試】測試員工B
 * 專門送單給萊乾資訊簽）：
 *   • 讀 ../last-run-lqtech.json（lqtech-ess.mjs 的 manifest）：ids 的每一個 id、萊乾資訊員工本身、colleague 段
 *     （B 的員工列、B 所在的【測試】部門、B 原有的特休餘額列）組成 lq_keep；組檔時替片段裡**每一句**
 *     DELETE／UPDATE（tenants 那句除外）自動包成 `WHERE (原條件) AND NOT (id = ANY(lq_keep))`，並替會選到
 *     萊乾資訊專用【測試】專案／考核範本／獎金批次的父表子查詢補上同一個排除條件。
 *   • test_emp 只排除萊乾資訊、**包含 B**：B 的其他 seed-test 資料照清，只有 lq_keep 裡的列留下。
 *     B 的登入帳號不在 SQL 裡（auth 一律 admin API），B 的員工列留著所以也不會出現在待刪帳號清單。
 *   • 寄給萊乾資訊、payload 沒有指向任何單據／專案／月表／員工的通知不刪（例如別的 session 做的
 *     「【測試】Email 通知寄送測試」）；指向要刪資料的照刪（不然會變成點不開的死連結）。
 *   • 重跑 lqtech-ess.mjs 之後要重跑本檔，lq_keep 才會是最新的。萊乾資訊自己的資料用 cleanup/lqtech-ess.sql。
 *
 * 驗證（兩種模式都跑）：本交易刪掉的列＝audit_logs（context cleanup:other-test-data）＋三張沒有 DELETE
 * 稽核的表（notifications／attendance_sheet_snapshots／knowledge_chunks，跑前快照比對）。據此算
 *   (a)  刪掉的列裡，歸屬非測試員工（含萊乾資訊）且本身與一／二層父列都沒有【測試】記號的筆數
 *   (a2) 刪掉的列裡，沒有歸屬任何員工、也沒有【測試】記號的筆數
 *   (b)  萊乾資訊 manifest 的列被刪的筆數（另外逐表確認 manifest 的 id 都還在）
 *   (c)  測試同仁 B 的保留項目被刪的筆數（員工列、部門、特休列、B 在 manifest 的單／關卡／事假額度；
 *        另外確認都還在、B 的 auth 帳號還在且不在待刪清單）
 *   以及 tenants.features 除 internalLinks 外是否原樣、要用 admin API 刪的 auth 帳號清單。
 * 乾跑：一律 RAISE EXCEPTION 回報（整包回滾）。正式執行：(a)／(a2)／(b)／(c)／features 任何一項不為 0
 * 就 RAISE EXCEPTION 整包回滾（保護條件的最後防線），全部通過才 COMMIT。
 *
 * ⚠️ auth 帳號不在 SQL 裡刪：00-base.sql 已改成由 Supabase admin API 逐一刪（清單見乾跑訊息）。
 * ⚠️ Storage 檔（憑證／文件／附件／收據／照片）不在 SQL 裡：先跑 cleanup/storage.mjs 再跑這份 SQL
 *    （storage.mjs 要從 DB 讀 storage_path，DB 先清就找不到路徑了）。
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const here = dirname(fileURLToPath(import.meta.url))
const ORDER = ["50-requirements.sql", "30-payroll.sql", "20-attendance.sql", "10-finance.sql", "40-people.sql", "00-base.sql"]
const TENANT = "0507ad78-27f4-480e-b99f-a72db2aee50c"
const LQ_DEFAULT = "9b9ffd9d-f25d-4e26-9b36-d5f1afa9196d" // 萊乾資訊（維護帳號）
const CONTEXT = "cleanup:other-test-data"
const dry = process.argv.includes("--dry-run")
const outPath = process.argv.find((a) => a.startsWith("--out="))?.slice(6)
  ?? resolve(here, dry ? "../../清理-後台測試資料.dry-run.sql" : "../../清理-後台測試資料.sql")

// ── 萊乾資訊 manifest → 保護清單 ───────────────────────────────────────────
const manifestPath = resolve(here, "../last-run-lqtech.json")
const lqManifest = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, "utf8")) : null
const LQ = lqManifest?.targetEmployeeId ?? LQ_DEFAULT
const keepByTable = Object.fromEntries(Object.entries(lqManifest?.ids ?? {}).filter(([, ids]) => ids.length > 0))
const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
for (const [table, ids] of Object.entries(keepByTable)) {
  if (!/^[a-z_]+$/.test(table)) throw new Error(`manifest 表名不合法：${table}`)
  for (const x of ids) if (!uuidRe.test(x)) throw new Error(`manifest ${table} 有不合法的 id：${x}`)
}
const colleague = lqManifest?.colleague ?? null
const colleagueKeepByTable = colleague
  ? { employees: [colleague.employeeId], departments: [colleague.departmentId], leave_balances: colleague.keptLeaveBalanceIds ?? [] }
  : {}
const colleagueManifestRows = colleague ? Object.values(colleague.manifestRows ?? {}).flat() : []
const colleagueUserId = colleague?.userId ?? null
for (const x of [...Object.values(colleagueKeepByTable).flat(), ...colleagueManifestRows, ...(colleagueUserId ? [colleagueUserId] : [])]) {
  if (!uuidRe.test(x)) throw new Error(`manifest.colleague 有不合法的 id：${x}`)
}
const colleagueKeep = Object.values(colleagueKeepByTable).flat()
const lqKeep = [LQ, ...Object.values(keepByTable).flat(), ...colleagueKeep]
const uuidArr = (ids) => `'{${ids.join(",")}}'::uuid[]`

// ── 片段 → 加上保護條件 ────────────────────────────────────────────────────
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

/** 會選到萊乾資訊專用【測試】父列的子查詢 → 補排除條件（[regex, 替換, 預期次數]）。 */
const SUBQUERY_GUARDS = [
  [/(SELECT\s+id(?:::text)?\s+FROM\s+projects\s+WHERE\s+tenant_id\s*=\s*t\s+AND\s+name\s+LIKE\s+'【測試】%')/g, "$1 AND NOT (id = ANY(lq_keep))", 7],
  [/(JOIN\s+projects\s+p\s+ON\s+p\.id\s*=\s*s\.project_id\s+WHERE\s+s\.tenant_id\s*=\s*t\s+AND\s+p\.name\s+LIKE\s+'【測試】%')/g, "$1 AND NOT (p.id = ANY(lq_keep))", 1],
  [/(SELECT\s+id\s+FROM\s+bonus_runs\s+WHERE\s+tenant_id\s*=\s*t\s+AND\s+label\s+LIKE\s+'【測試】%')/g, "$1 AND NOT (id = ANY(lq_keep))", 1],
  [/(SELECT\s+id\s+FROM\s+kpi_templates\s+WHERE\s+tenant_id\s*=\s*t\s+AND\s+name\s+LIKE\s+'【測試】%')/g, "$1 AND NOT (id = ANY(lq_keep))", 1],
]

const stats = { statements: 0, guarded: 0, notifGuards: 0, subqueries: SUBQUERY_GUARDS.map(() => 0) }
function protect(body) {
  let out = body
  SUBQUERY_GUARDS.forEach(([re, rep], i) => {
    out = out.replace(re, (...m) => {
      stats.subqueries[i]++
      return rep.replace("$1", m[1])
    })
  })
  // 每一句 DELETE／UPDATE（行首開頭，到第一個分號）→ WHERE (原條件) AND NOT (id = ANY(lq_keep))
  out = out.replace(/^(\s*)((?:DELETE FROM|UPDATE)\s[\s\S]*?);/gm, (whole, indent, stmt) => {
    stats.statements++
    if (/^UPDATE\s+(public\.)?tenants\b/.test(stmt)) return whole // tenants：只過濾 internalLinks，不是資料列
    const w = stmt.search(/\bWHERE\b/)
    if (w < 0) throw new Error(`沒有 WHERE 的語句，拒絕組檔：${stmt.slice(0, 80)}`)
    stats.guarded++
    const extra = /^DELETE FROM\s+(public\.)?notifications\b/.test(stmt)
      ? `\n${indent}    AND NOT (employee_id = lq AND NOT (coalesce(payload, '{}'::jsonb) ?| array['requestId','projectId','sheetId','disbursementId','changeRequestId','employeeId']))`
      : ""
    if (extra) stats.notifGuards++
    return `${indent}${stmt.slice(0, w)}WHERE (${stmt.slice(w + 5).trim()})\n${indent}    AND NOT (id = ANY(lq_keep))${extra};`
  })
  return out
}

const parts = ORDER.map((f) => {
  const body = protect(stripHeader(readFileSync(join(here, f), "utf8")))
  return `  -- ───────────────────────── ${f} ─────────────────────────\n` +
    body.split("\n").map((l) => (l ? `  ${l}` : l)).join("\n")
})
SUBQUERY_GUARDS.forEach(([re, , expected], i) => {
  if (stats.subqueries[i] !== expected) throw new Error(`子查詢保護 ${re} 套用 ${stats.subqueries[i]} 次，預期 ${expected} 次（片段改過了？）`)
})
if (/DELETE\s+FROM\s+auth\./i.test(parts.join("\n"))) throw new Error("片段裡還有刪 auth.* 的語句；auth 帳號改用 admin API 刪")

// ── 驗證 SQL（萊乾資訊 manifest 逐表確認還在）──────────────────────────────
const keepExistSql = Object.entries(keepByTable)
  .map(([table, ids]) => `(SELECT count(*) FROM unnest(${uuidArr(ids)}) x(id) WHERE NOT EXISTS (SELECT 1 FROM public.${table} y WHERE y.id = x.id))`)
  .join("\n        + ") || "0"
const keepTotal = Object.values(keepByTable).reduce((s, ids) => s + ids.length, 0)
const colleagueExistSql = [...Object.entries(colleagueKeepByTable), ...Object.entries(colleague?.manifestRows ?? {})]
  .filter(([table, ids]) => ids.length > 0 && /^[a-z_]+$/.test(table))
  .map(([table, ids]) => `(SELECT count(*) FROM unnest(${uuidArr(ids)}) x(id) WHERE NOT EXISTS (SELECT 1 FROM public.${table} y WHERE y.id = x.id))`)
  .join("\n        + ") || "0"
const colleagueTotal = colleagueKeep.length + colleagueManifestRows.length + (colleagueUserId ? 1 : 0)

const TEXT_KEYS = ["name", "title", "label", "purpose", "payee_name", "note", "reason", "description", "school", "company", "file_name", "status_reason", "delete_reason", "void_reason", "location", "comment", "address", "english_name", "body", "content", "action", "remark", "dept_name", "issuer", "major", "disbursement_no", "anomaly_ack"]

const verify = `
  -- ── 驗證：本交易刪了什麼、保護條件（乾跑一律回報；正式執行違反就整包回滾）──────────
  DECLARE
    v_counts     text;
    v_a          integer;
    v_a_detail   text;
    v_a2         integer;
    v_a2_detail  text;
    v_b          integer;
    v_b_exist    integer;
    v_c          integer;
    v_c_exist    integer;
    v_marked     text;
    v_auth       text;
    v_features   boolean;
    v_links      text;
    v_left       text;
  BEGIN
    CREATE TEMP TABLE _del ON COMMIT DROP AS
      SELECT DISTINCT ON (table_name, record_id) table_name AS tbl, record_id AS id, old_row AS r
        FROM public.audit_logs
       WHERE action = 'DELETE' AND context = '${CONTEXT}' AND at >= now()
       ORDER BY table_name, record_id;
    INSERT INTO _del SELECT 'notifications', p.id, p.r FROM _pre_notif p WHERE NOT EXISTS (SELECT 1 FROM public.notifications x WHERE x.id = p.id);
    INSERT INTO _del SELECT 'attendance_sheet_snapshots', p.id, p.r FROM _pre_snap p WHERE NOT EXISTS (SELECT 1 FROM public.attendance_sheet_snapshots x WHERE x.id = p.id);
    INSERT INTO _del SELECT 'knowledge_chunks', p.id, p.r FROM _pre_chunk p WHERE NOT EXISTS (SELECT 1 FROM public.knowledge_chunks x WHERE x.id = p.id);
    SELECT string_agg(tbl || '=' || n, ' ' ORDER BY tbl) INTO v_counts FROM (SELECT tbl, count(*) n FROM _del GROUP BY tbl) x;

    -- 【測試】記號：文字欄位以【測試】開頭、code 以 test_ 開頭、屬於測試員工；通知看標題／內文含【測試】
    CREATE TEMP TABLE _cls ON COMMIT DROP AS
      SELECT d.tbl, d.id, d.r, d.r ->> 'employee_id' AS emp,
             ( EXISTS (SELECT 1 FROM jsonb_each_text(d.r) kv
                        WHERE kv.key IN (${TEXT_KEYS.map((k) => `'${k}'`).join(", ")})
                          AND kv.value LIKE '【測試】%')
               OR coalesce(d.r ->> 'code', '') LIKE 'test\\_%'
               OR coalesce(d.r ->> 'address', '') LIKE '%.test.aster.local'
               OR (d.r ->> 'employee_id') = ANY(test_emp::text[])
               OR (d.tbl = 'notifications' AND (coalesce(d.r ->> 'title', '') LIKE '%【測試】%' OR coalesce(d.r ->> 'body', '') LIKE '%【測試】%'))
             ) AS m0,
             false AS m1, false AS m2, NULL::text AS owner
        FROM _del d;
    -- r 裡任何 uuid（含 payload 巢狀）指到另一個被刪的列＝父列
    CREATE TEMP TABLE _ref ON COMMIT DROP AS
      SELECT DISTINCT c.id AS child, (v #>> '{}')::uuid AS parent
        FROM _cls c, LATERAL jsonb_path_query(c.r, 'strict $.**') v
       WHERE jsonb_typeof(v) = 'string'
         AND (v #>> '{}') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
         AND (v #>> '{}')::uuid <> c.id;
    UPDATE _cls c SET m1 = c.m0 OR EXISTS (SELECT 1 FROM _ref f JOIN _cls p ON p.id = f.parent WHERE f.child = c.id AND p.m0);
    UPDATE _cls c SET m2 = c.m1 OR EXISTS (SELECT 1 FROM _ref f JOIN _cls p ON p.id = f.parent WHERE f.child = c.id AND p.m1);
    -- 歸屬：自己的 employee_id；沒有就看被刪的父單（申請單／月表／報銷）是誰的
    UPDATE _cls c SET owner = coalesce(c.emp,
      (SELECT p.r ->> 'employee_id' FROM _ref f JOIN _cls p ON p.id = f.parent
        WHERE f.child = c.id AND p.tbl IN ('leave_requests', 'attendance_sheets', 'expense_claims') LIMIT 1));

    SELECT count(*), string_agg(DISTINCT tbl, ',') INTO v_a, v_a_detail FROM _cls
     WHERE owner IS NOT NULL AND NOT (owner = ANY(test_emp::text[])) AND NOT m2;
    SELECT count(*), string_agg(DISTINCT tbl, ',') INTO v_a2, v_a2_detail FROM _cls WHERE owner IS NULL AND NOT m2;
    SELECT string_agg(k || '=' || n, ' ' ORDER BY k) INTO v_marked FROM (
      SELECT tbl || CASE WHEN owner = lq::text THEN '(萊乾資訊)' ELSE '(真人)' END AS k, count(*) n FROM _cls
       WHERE owner IS NOT NULL AND NOT (owner = ANY(test_emp::text[])) AND m2 GROUP BY 1) x;
    SELECT count(*) INTO v_b FROM _del WHERE id = ANY(lq_keep);
    v_b_exist := ${keepExistSql}
        + (SELECT CASE WHEN EXISTS (SELECT 1 FROM public.employees WHERE tenant_id = t AND id = lq AND status = 'active') THEN 0 ELSE 1 END);
    -- (c) 測試同仁 B：保留項目（員工列／部門／特休列）＋ B 在 manifest 的單／關卡／事假額度＋ auth 帳號
    SELECT count(*) INTO v_c FROM _del WHERE id = ANY(${uuidArr([...colleagueKeep, ...colleagueManifestRows])});
    v_c_exist := ${colleagueExistSql}${colleague ? `
        + (SELECT CASE WHEN EXISTS (SELECT 1 FROM public.employees WHERE tenant_id = t AND id = '${colleague.employeeId}' AND status = 'active') THEN 0 ELSE 1 END)` : ""}${colleagueUserId ? `
        + (SELECT CASE WHEN EXISTS (SELECT 1 FROM auth.users WHERE id = '${colleagueUserId}') THEN 0 ELSE 1 END)` : ""};

    SELECT string_agg((d.r ->> 'user_id') || '＠' || coalesce(split_part(u.email, '@', 2), '（auth 無此帳號）'), ' ' ORDER BY d.r ->> 'user_id') INTO v_auth
      FROM _del d LEFT JOIN auth.users u ON u.id = (d.r ->> 'user_id')::uuid
     WHERE d.tbl = 'employees' AND d.r ->> 'user_id' IS NOT NULL;
${colleagueUserId ? `    IF coalesce(v_auth, '') LIKE '%${colleagueUserId}%' THEN v_c := v_c + 1; END IF;
` : ""}    SELECT (f_before - 'internalLinks') = (features - 'internalLinks'),
           jsonb_array_length(coalesce(f_before -> 'internalLinks', '[]')) || '→' || jsonb_array_length(coalesce(features -> 'internalLinks', '[]'))
      INTO v_features, v_links FROM public.tenants WHERE id = t;

    SELECT string_agg(k || '=' || v, ' ') INTO v_left FROM (
      SELECT 'test_employees_outside_keep' k, count(*)::text v FROM public.employees WHERE tenant_id = t AND name LIKE '【測試】%' AND NOT (id = ANY(lq_keep))
      UNION ALL SELECT 'test_like_rows_outside_lq', (
          (SELECT count(*) FROM public.departments WHERE tenant_id = t AND name LIKE '【測試】%' AND NOT (id = ANY(lq_keep)))
        + (SELECT count(*) FROM public.projects WHERE tenant_id = t AND name LIKE '【測試】%' AND NOT (id = ANY(lq_keep)))
        + (SELECT count(*) FROM public.disbursements WHERE tenant_id = t AND purpose LIKE '【測試】%')
        + (SELECT count(*) FROM public.bonus_runs WHERE tenant_id = t AND label LIKE '【測試】%' AND NOT (id = ANY(lq_keep)))
        + (SELECT count(*) FROM public.clients WHERE tenant_id = t AND name LIKE '【測試】%')
        + (SELECT count(*) FROM public.vendors WHERE tenant_id = t AND name LIKE '【測試】%')
        + (SELECT count(*) FROM public.companies WHERE tenant_id = t AND name LIKE '【測試】%')
        + (SELECT count(*) FROM public.announcements WHERE tenant_id = t AND title LIKE '【測試】%')
        + (SELECT count(*) FROM public.company_pages WHERE tenant_id = t AND title LIKE '【測試】%')
        + (SELECT count(*) FROM public.job_requisitions WHERE tenant_id = t AND title LIKE '【測試】%')
        + (SELECT count(*) FROM public.knowledge_documents WHERE tenant_id = t AND title LIKE '【測試】%')
        + (SELECT count(*) FROM public.kpi_templates WHERE tenant_id = t AND name LIKE '【測試】%' AND NOT (id = ANY(lq_keep)))
        + (SELECT count(*) FROM public.leave_types WHERE tenant_id = t AND code LIKE 'test\\_%')
        + (SELECT count(*) FROM public.shifts WHERE tenant_id = t AND name LIKE '【測試】%')
        + (SELECT count(*) FROM public.expense_categories WHERE tenant_id = t AND code LIKE 'test\\_%')
        + (SELECT count(*) FROM public.expense_settlements WHERE tenant_id = t AND note LIKE '【測試】%')
        + (SELECT count(*) FROM public.tenant_calendar_days WHERE tenant_id = t AND label LIKE '【測試】%')
        + (SELECT count(*) FROM public.notifications WHERE tenant_id = t AND (title LIKE '%【測試】%' OR body LIKE '%【測試】%') AND NOT (id = ANY(lq_keep))
             AND NOT (employee_id = lq AND NOT (coalesce(payload, '{}'::jsonb) ?| array['requestId','projectId','sheetId','disbursementId','changeRequestId','employeeId'])))
        + (SELECT count(*) FROM public.leave_requests WHERE tenant_id = t AND reason LIKE '【測試】%' AND NOT (id = ANY(lq_keep)))
      )::text
      UNION ALL SELECT 'test_internal_links', (SELECT count(*) FROM public.tenants, jsonb_array_elements(coalesce(features -> 'internalLinks', '[]')) l WHERE id = t AND l ->> 'name' LIKE '【測試】%')::text
      UNION ALL SELECT 'lq_manifest_rows_present', (${keepTotal} - (${keepExistSql}))::text || '/${keepTotal}'
      UNION ALL SELECT 'colleague_rows_missing', v_c_exist::text || '（共 ${colleagueTotal} 項）'
      UNION ALL SELECT 'real_employees', count(*)::text FROM public.employees WHERE tenant_id = t AND name NOT LIKE '【測試】%'
    ) x;
${dry ? `
    RAISE EXCEPTION E'DRY_RUN_ROLLBACK（全部語句都能執行，這裡故意回滾）\\n deleted: %\\n (a) 非測試員工且無【測試】記號: % [%]\\n (a2) 無歸屬且無記號: % [%]\\n (b) 萊乾資訊 manifest 被刪: %（逐表存在檢查缺 %）\\n (c) 測試同仁 B 保留項目被刪: %（存在檢查缺 %）\\n 非測試員工但有【測試】記號（指向測試資料的通知／簽收列等）: %\\n features 除 internalLinks 外原樣: %（internalLinks %）\\n 要用 admin API 刪的 auth 帳號: %\\n 刪後剩餘: %',
      v_counts, v_a, coalesce(v_a_detail, '-'), v_a2, coalesce(v_a2_detail, '-'), v_b, v_b_exist, v_c, v_c_exist, coalesce(v_marked, '-'), v_features, v_links, coalesce(v_auth, '-'), v_left;` : `
    IF v_a > 0 OR v_a2 > 0 OR v_b > 0 OR v_b_exist > 0 OR v_c > 0 OR v_c_exist > 0 OR NOT v_features THEN
      RAISE EXCEPTION 'PROTECTION_VIOLATION（整包回滾）(a)=% [%] (a2)=% [%] (b)=%/% (c)=%/% features_ok=%', v_a, v_a_detail, v_a2, v_a2_detail, v_b, v_b_exist, v_c, v_c_exist, v_features;
    END IF;
    RAISE NOTICE 'deleted: % | 非測試員工但有記號: % | internalLinks % | 待 admin API 刪的 auth 帳號: % | 剩餘: %', v_counts, v_marked, v_links, v_auth, v_left;`}
  END;`

const sql = `-- =====================================================================
-- 亞斯特 — 清除「萊乾資訊以外」的後台【測試】資料（由 docs/test/seed-test/cleanup/build.mjs 產生${dry ? "；DRY-RUN 版，結尾整包回滾" : ""}）
--
-- 用途：業主驗完後台功能後，一次刪光 docs/test/seed-test/*.mjs 與驗收灌進正式租戶的測試資料：
--   【測試】員工（T001～T005、報到者C）與他們名下的一切、測試部與子組、假別／班別／行事曆／
--   內部連結、專案／合約／期款／副委託／放款／獎金批次／客戶／廠商／公司主體、排班／打卡／出勤日／
--   月表／假單／簽核／餘額／預支／補休、薪資結構／薪資單／調薪／眷屬／非員工所得／費用類別／報銷／月結、
--   報到／招募／考核／專屬信箱／公告（含簽收列）／公司資訊頁／知識庫，以及掛在測試員工、提到【測試】
--   或指向這些資料的通知。
-- 保留：萊乾資訊（${LQ}）與 docs/test/seed-test/last-run-lqtech.json 列出的 ${keepTotal} 列，以及測試同仁
--   T002【測試】測試員工B${colleague ? `（${colleague.employeeId}）` : ""} 的員工列、所在【測試】部門、原有特休餘額列（lq_keep；每一句
--   DELETE／UPDATE 都排除）。B 的其他 seed-test 資料照清。要清萊乾資訊自己的測試資料用 cleanup/lqtech-ess.sql。
-- 不動：真實員工與他們的任何資料、租戶設定（features 只移除【測試】內部連結）、audit_logs、Storage 備份快照。
-- 前置：先跑 \`node docs/test/seed-test/cleanup/storage.mjs\` 刪 Storage 檔（它要先從 DB 讀路徑）。
-- 之後：auth 登入帳號用 Supabase admin API 刪（清單見乾跑訊息「要用 admin API 刪的 auth 帳號」）。
-- 執行：Supabase Management API query 端點或 SQL Editor（單一交易，任何一句失敗整包回滾）。
--   結尾驗證 (a)／(a2)／(b)／features 任一項不為 0 就整包回滾（見 build.mjs 檔頭）。
-- 冪等：可重複執行（第二次全部 0 列）。
-- =====================================================================

DO $$
DECLARE
  t        uuid := '${TENANT}';
  test_emp uuid[];
  lq       uuid := '${LQ}';   -- 萊乾資訊：永遠保留
  -- 萊乾資訊 manifest 的全部 id＋萊乾資訊員工本身＋測試同仁 B 的保留項目（保護：每一句 DELETE／UPDATE 都排除）
  lq_keep  uuid[] := ${uuidArr(lqKeep)};
  f_before jsonb;
BEGIN
  IF (SELECT status FROM public.tenants WHERE id = t) <> 'active' THEN
    RAISE EXCEPTION 'tenant % is not active (status=%)', t, (SELECT status FROM public.tenants WHERE id = t);
  END IF;
  -- 測試員工＝名字以【測試】開頭（T001～T005 ＋ 報到完成產生的無帳號報到者C）；萊乾資訊明確排除。
  -- 測試同仁 B 刻意留在 test_emp 裡：B 的其他 seed-test 資料照清，B 的員工列等保留項目靠 lq_keep 擋下。
  SELECT COALESCE(array_agg(id), '{}') INTO test_emp
    FROM public.employees WHERE tenant_id = t AND name LIKE '【測試】%' AND id <> lq;
  RAISE NOTICE 'test employees: %', COALESCE(array_length(test_emp, 1), 0);

  -- 稽核 context（驗證靠它找出本交易刪掉的列）；三張沒有 DELETE 稽核的表先快照
  PERFORM set_config('request.headers', '{"x-actor-route":"${CONTEXT}"}', true);
  SELECT features INTO f_before FROM public.tenants WHERE id = t;
  CREATE TEMP TABLE _pre_notif ON COMMIT DROP AS
    SELECT id, jsonb_build_object('employee_id', employee_id, 'type', type, 'title', title, 'body', body, 'payload', payload) AS r
      FROM public.notifications WHERE tenant_id = t;
  CREATE TEMP TABLE _pre_snap ON COMMIT DROP AS
    SELECT id, jsonb_build_object('employee_id', employee_id, 'sheet_id', sheet_id) AS r
      FROM public.attendance_sheet_snapshots WHERE tenant_id = t;
  CREATE TEMP TABLE _pre_chunk ON COMMIT DROP AS
    SELECT id, jsonb_build_object('document_id', document_id) AS r
      FROM public.knowledge_chunks WHERE tenant_id = t;

  -- sql/0018 forbid_hard_delete／0034 forbid_paid_bonus_mutation／0019 audit append-only
  -- 只對 status IN ('test','demo') 的租戶放行實體刪除：同一交易內切 demo → 刪 → 切回 active。
  UPDATE public.tenants SET status = 'demo' WHERE id = t;

${parts.join("\n\n")}

  UPDATE public.tenants SET status = 'active' WHERE id = t;
${verify}
END $$;
`
writeFileSync(outPath, sql)
console.log(`${dry ? "[dry-run] " : ""}wrote ${outPath} (${sql.split("\n").length} lines)；語句 ${stats.statements}（加保護 ${stats.guarded}，其中通知 ${stats.notifGuards}）、子查詢保護 ${stats.subqueries.join("/")}、lq_keep ${lqKeep.length} 個 id（含測試同仁 ${colleagueKeep.length}）`)
