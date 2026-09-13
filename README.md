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
- Worker（Railway）: `apps/worker`，排程時鐘（每日出勤結算 02:00、異常偵測 03:00、專案自動封存 04:00、
  專案示警 04:30、通知投遞每 5 分鐘），全部透過 API 的 `/internal/*` 端點執行；
  Railway 的建置／啟動設定就是 repo 根目錄的 `railway.json`（這個 repo 只有 worker 一個 Railway 服務）。
  需要的環境變數：`REDIS_URL`、`ENABLE_WORKER_SCHEDULERS=true`、`API_INTERNAL_URL`、`INTERNAL_JOB_TOKEN`；
  API 端要對應開 `ENABLE_INTERNAL_JOBS=true` 並設同一把 `INTERNAL_JOB_TOKEN`。

> 舊的 `hr-theta-peach.vercel.app`（更名前的 HRLink 版本）與 Railway 上的 API
> 皆已停用（API 現在只在 Vercel）。上面三個才是現行環境。
