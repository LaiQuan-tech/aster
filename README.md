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
  異常偵測 03:00、專案自動封存 04:00、專案示警 04:30、通知投遞每 5 分鐘），本身不碰 DB，
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
