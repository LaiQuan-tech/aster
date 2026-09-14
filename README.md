# HR 差勤 SaaS（白標多租戶）

多租戶白標人資差勤管理系統。差勤打卡 + 排班 + 簽核 + 工時 + 薪資 + 考核 KPI + 報表 + AI 自動化。

- 設計文件：[`docs/plans/2026-06-23-hr-saas-design.md`](docs/plans/2026-06-23-hr-saas-design.md)
- P0 實作計畫：[`docs/plans/2026-06-23-p0-foundation.md`](docs/plans/2026-06-23-p0-foundation.md)

## 技術棧

Monorepo（npm workspace + Turbo）｜`apps/web` Next.js 16｜`apps/api` Express 5｜`apps/worker` BullMQ｜`packages/db` Drizzle + Supabase + RLS｜`packages/rules` 規則/薪資引擎。

> 狀態：核心模組已實作（差勤、人事主檔、招募 ATS、台灣薪資法規等）。
> 對標 Apollo/MayoHR 的補齊計畫見 [`docs/plans/2026-07-01-apollo-parity.md`](docs/plans/2026-07-01-apollo-parity.md)。

## 線上環境
- Web（Vercel）: https://aster-system.vercel.app
- API（Vercel）: https://aster-hr-api.vercel.app/health
- Worker（Railway，2026-09-14 上線）: `apps/worker`，排程時鐘（台北時間：每日出勤結算 02:00、
  異常偵測 03:00、專案自動封存 04:00、專案示警 04:30、通知投遞每 5 分鐘、每月 1 日 05:00 產生上月出勤月表、
  每月 1 日 06:00 月度資料快照），本身不碰 DB，
  全部透過 API 的 `/internal/*` 端點執行。Railway 專案 `aster`（帳號 gathertaiwan@gmail.com）
  底下兩個服務：`Redis`（BullMQ 用）與 `worker`。

  - **部署方式是 `railway up`，不是 GitHub 自動部署**：這個 Railway 帳號沒接 LaiQuan-tech 這個
    GitHub 組織（`railway add --repo` 回 repo not found），所以改 worker 程式後要在 repo 根目錄跑
    `railway up -s worker -c`（先 `railway link -p 2136f8c1-04b4-4693-8de6-47c4c1496fc1`）。
  - **建置／啟動指令設在 Railway 服務設定上，不在 repo**：Railway 已把 `railway.json` 這種
    config-as-code 列為 deprecated，新服務會直接忽略它（實測：檔案在、設定全沒套上，Railpack 找不到
    start command 而失敗）。現行設定＝builder Nixpacks、build `npm run build -w @hr/worker`、
    start `npm run start -w @hr/worker`、healthcheck `/health`。
  - worker 需要的變數：`REDIS_URL=${{Redis.REDIS_URL}}?family=0`（Railway 內網是 IPv6-only，
    ioredis 預設只解 IPv4，沒有 `?family=0` 會連不上）、`ENABLE_WORKER_SCHEDULERS=true`、
    `API_INTERNAL_URL=https://aster-hr-api.vercel.app`、`INTERNAL_JOB_TOKEN`；
    API 端（Vercel）要對應開 `ENABLE_INTERNAL_JOBS=true` 並設同一把 `INTERNAL_JOB_TOKEN`。
  - 通知投遞的 email／LINE 管道尚未設定（API 沒有 `RESEND_API_KEY`／`NOTIFICATION_EMAIL_FROM`／
    `LINE_CHANNEL_ACCESS_TOKEN`／`NOTIFICATION_DEFAULT_CHANNELS`），目前排程只會產生站內通知。

> 舊的 `hr-theta-peach.vercel.app`（更名前的 HRLink 版本）與 Railway 上的 API
> 皆已停用（API 現在只在 Vercel）。上面三個才是現行環境。

## 環境變數

完整清單與說明見 [`.env.example`](.env.example)（複製成 repo 根目錄 `.env`；web／api／worker 三邊都讀同一份）。
線上由 Vercel／Railway 各自注入。與帳號／寄信相關的幾個：

| 變數 | 誰用 | 說明 |
|---|---|---|
| `RESEND_API_KEY` | API | Resend 金鑰。**未設時邀請信／重設密碼信改走 dryRun**：不寄信，API 把設密碼連結回給 HR 手動轉交（後台會顯示可複製的連結）。 |
| `NOTIFICATION_EMAIL_FROM` | API | 寄件人（需為 Resend 已驗證網域）。有 `RESEND_API_KEY` 卻缺這個會直接報錯。 |
| `WEB_URL` | API | 邀請信／重設密碼信裡連結指向的前台網址。未設預設 `https://aster-system.vercel.app`；本機開發填 `http://localhost:3000`。 |
| `WEB_ORIGINS` | API | CORS 白名單（逗號分隔），改前台網域要同步更新並重新部署 API。 |
| `NEXT_PUBLIC_API_URL` | web | 前台打的 API 位址（build 時 inline 進 bundle）。 |

帳號流程（A1）：HR 在後台「員工主檔」單筆或貼 CSV 批次建帳號 → 系統寄邀請信（`/auth/set-password?token_hash=…&type=invite`）→ 員工自設密碼；
HR 配發暫時密碼（`POST /employees` 帶密碼、或「配發暫時密碼」）會把 `employees.must_change_password` 設為 true，員工首次登入會被導去強制改密碼；
員工可在「我的資料」改密碼、在登入頁「忘記密碼？」自助重設。

## Demo 租戶灌測試資料

正式站的 demo 租戶（`admin@kimihr.app`）給老闆看後台用，本身沒有員工/出勤資料。兩支
可重跑腳本直接打線上 API 把資料灌進去：

- [`docs/test/seed-attendance-demo.mjs`](docs/test/seed-attendance-demo.mjs) — 五名員工
  （依 `docs/test/fixtures/attendance-115-06/` 的真實 Excel 出勤表轉出的 fixture）+
  部門/班別/假別/薪資/排班/打卡/請假，跑完呼叫 `attendance-sheets/generate` 產生
  2026-06 出勤月表，並把系統算出來的數字跟 Excel 原始查核值並排印出來比對。
- [`docs/test/seed-projects-demo.mjs`](docs/test/seed-projects-demo.mjs) — 專案申請單/
  合約/請款/副委託等 P3 模組的示範資料（不動員工/出勤，只讀 `GET /employees`）。

跑法：`node docs/test/seed-attendance-demo.mjs`（`API_URL`／`ADMIN_EMAIL`／
`ADMIN_PASSWORD` 可用環境變數覆寫；讀 repo 根目錄 `.env` 的 `SUPABASE_URL`／
`SUPABASE_ANON_KEY` 換 HR 的 JWT，值不會被印出來）。兩支都是冪等設計，
已存在的部門/員工/打卡/請假單/專案會直接沿用、不重複建立，可放心重跑。

## 備份政策（C3，2026-09-15）

客戶要求「每月一次全系統資料快照（Final 版鎖定）備查，資料被覆蓋／誤刪回得去」。分三層：

1. **應用層月度快照（已上線）** — worker 排程 `monthly-snapshot`（每月 1 日 06:00 台北，排在月表產生之後）
   打 `POST /internal/backups/monthly-snapshot`，對每個 active 租戶把 `apps/api/src/services/backup-snapshot.ts`
   裡 `SNAPSHOT_TABLES` 列的業務表（人事／出勤／月表／請假／薪資／專案／放款／公告／招募／稽核 log 等 60 餘張；
   刻意不收 notifications、knowledge_chunks、personal_notes、user_preferences）**全表**（非增量）逐表分頁讀出、gzip
   後上傳私有 bucket `tenant-snapshots/{tenantId}/{period}/{table}.json.gz`，最後寫 `manifest.json`
   （每表列數／bytes／sha256、產生時間、drizzle／sql schema 版本）。同一 period 重跑＝先清資料夾再覆蓋。
   - API 端一次呼叫只做一段（12 秒軟預算，Vercel maxDuration 60），回 `nextTenantId/nextTable/nextOffset`，
     worker 端 `while(!done)` 續打（上限 300 次）；進度存在 Storage 的 manifest（`status: running → complete`）。
   - 後台「系統設定 › 資料快照備份」（`/admin/backups`）：看每月快照的 manifest（各表列數、大小）、
     「立即產生本月快照」（前端迴圈續打並顯示進度）、下載 manifest／各表 gz（15 分鐘 signed URL）。
   - **保留 24 個月**，超過的由維護人員手動從 Storage 清（目前沒有自動清除，避免誤刪）。
2. **整公司月結 Final** — `POST /attendance-sheets/close-period {period, force?}`（HR）：該月所有在職員工的月表都要
   approved／locked，否則 409 `sheets_not_approved` 附清單（含「尚未產生月表」）；通過就把 approved 全部轉
   locked（沿用 `lockSheet`）並寫 `period_closes`（unique(tenant, period)，記 sheet_count／locked_count／
   操作者／該月快照 manifest 路徑）。`force: true` 只鎖已核准的、略過其餘並記在 note。
   `POST /attendance-sheets/reopen-period {period, reason}` 只把紀錄標成 reopened、留理由，**不解鎖月表**
   （要改哪張表走該表自己的 reopen）。後台「出勤月表 · 月結簽核」頁有「本月 Final 月結」按鈕與已月結徽章。
3. **月表快照歷史** — 每次 `approveSheet` 都往 `attendance_sheet_snapshots` 追加一列（seq 遞增、不可刪），
   return／reopen 只清 `attendance_sheets.snapshot`、歷史不動；`GET /attendance-sheets/:id/snapshots`（HR）列出。

**平台側（待確認方案）**：資料庫本體由 Supabase 託管。Free 方案沒有自動備份、也沒有 PITR；Pro 方案有每日
備份（保留 7 天），PITR（時間點還原）是 Pro 以上的付費加購、要另外開啟才有。**目前這個專案用哪個方案、
有沒有開 PITR，請以 Supabase dashboard 為準（待確認）**——上面的應用層快照是「不管平台方案為何都一定有的」那一層。

**還原方式（人工，不做一鍵還原）**：從 `/admin/backups` 或直接從 Storage 下載該月的 `manifest.json` 與各表
`.json.gz`；`gunzip` 後每個檔案是該表整份列陣列（PostgREST 原始欄位名，含 id／tenant_id）。先比對 manifest 的
`schemaVersion` 與現行 migration 是否一致（不一致要先處理欄位差異），再由維護人員用 service_role 對目標表
`upsert`（以 id 為鍵；只還原確認要救回的那幾張表／那幾列），還原前先對現況再做一次快照。多頁的表會拆成
`{table}.part-0001.json.gz`…，manifest 的 `files` 列出順序；表級 sha256＝各檔 sha256 以換行串起再 sha256。
