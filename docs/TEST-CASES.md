# HR SaaS — 測試案例文件（TEST-CASES）

對象：已部署之線上 HR API
`https://hr-production-994f.up.railway.app`

自動化腳本：[`docs/test/live-e2e.mjs`](./test/live-e2e.mjs)
執行方式：`node docs/test/live-e2e.mjs`

## 測試環境與前置條件

| 項目 | 說明 |
| --- | --- |
| API Base | `https://hr-production-994f.up.railway.app`（可用 `API_BASE` 環境變數覆蓋） |
| 請求 Origin | `https://hr-theta-peach.vercel.app`（CORS 白名單，每個請求都帶；可用 `WEB_ORIGIN` 覆蓋） |
| Supabase | 專案 ref `xpbxfeslajiwkmfigjul`；憑證讀自 repo 根目錄 `.env`（`SUPABASE_URL` / `SUPABASE_ANON_KEY` / `SUPABASE_SERVICE_ROLE_KEY`） |
| 測試資料 | 每次執行用 service_role 建立全新唯一租戶 `E2E-<timestamp>`，與第二租戶 `E2E-B-<timestamp>`；三名 auth 使用者（hr_admin / manager / employee，email 唯一、`email_confirm:true`、`app_metadata.tenant_id`），各自 `signInWithPassword` 取得 JWT。 |
| 權限模型 | `requireAuth`（驗 Bearer token）→ `requireTenant`（從 JWT `app_metadata.tenant_id` 取租戶）→ `requireRole`（從 `employees.role` 查角色）。HR 寫入端點需 `hr_admin`/`platform_admin`。 |
| 認證方式 | 每個請求帶 `Authorization: Bearer <token>`。 |
| 清理 | `afterAll` 依 FK 順序清掉所有建立的列，再刪 auth 使用者；最後驗證零殘留。**不影響既有資料**（測試只新增唯一租戶，刪除僅針對自己建立的 tenant_id）。 |

## 最新執行結果

- 總計：**PASS 171 / FAIL 0**
- 清理：**cleanup errors 0、殘留 0**（獨立複查：E2E 租戶 0、`e2e-` 使用者 0，租戶/員工總數回到基線）
- 行程退出碼：`0`
- 重跑穩定（多次 171/171）。

> ⚠️ 以上數字是 2026-10-11 班表功能移除**之前**最後一次執行的結果。移除後腳本已改（拿掉 5-4～5-6、13-1 改成直接寫
> `schedules` 列），**尚未重跑**——重跑後 PASS 總數會變（少 6 個斷言、13-1 前置多 1 個），其餘表格的「實際」欄也應以重跑結果為準。

> 下表「實際」欄為最新一次執行的結果。`POST /attendance/settle` 一案在第一版腳本誤期望 201，經對照 `apps/api/src/routes/attendance.ts:51` 實際回傳 200 後修正腳本（屬腳本問題，非 API bug），現已 PASS。

---

## 後端 API 測試案例

### 0. 佈建與認證（PROVISION）

| # | 測試案例 | 前置 | 步驟 | 預期 | 實際 |
| --- | --- | --- | --- | --- | --- |
| 0-1 | 佈建三名使用者並登入 | 租戶 A 已建 | service_role 建 hr/mgr/emp + employees 列，三者 `signInWithPassword` | 三個 token 皆取得 | PASS |
| 0-2 | JWT 帶 tenant_id | 已登入 | 檢查 hr 的 `app_metadata.tenant_id` | == 租戶 A id | PASS |

### 1. /me 與認證防護

| # | 測試案例 | 前置 | 步驟 | 預期 | 實際 |
| --- | --- | --- | --- | --- | --- |
| 1-1 | HR 取自身檔案 | hr token | `GET /me` | 200；`role=hr_admin`、`id`=hr empId、`email` 相符 | PASS |
| 1-2 | 員工取自身檔案 | emp token | `GET /me` | 200；`role=employee` | PASS |
| 1-3 | 無 token | 無 | `GET /me` | 401 | PASS |
| 1-4 | 壞 token | 假 JWT | `GET /me` | 401 | PASS |

### 2. 租戶白標 branding

| # | 測試案例 | 前置 | 步驟 | 預期 | 實際 |
| --- | --- | --- | --- | --- | --- |
| 2-1 | 讀取自家 branding | hr token | `GET /api/tenant/branding` | 200；`branding.appName`==租戶名、`features.payroll=true` | PASS |

### 3. 部門 departments CRUD + RBAC

| # | 測試案例 | 前置 | 步驟 | 預期 | 實際 |
| --- | --- | --- | --- | --- | --- |
| 3-1 | HR 建立部門 | hr token | `POST /departments {name:"工程部"}` | 201；回傳 `id` | PASS |
| 3-2 | 列出部門 | 已建 | `GET /departments` | 200；清單含新部門 | PASS |
| 3-3 | 更新部門 | 已建 | `PATCH /departments/:id {name:"研發部"}` | 200 | PASS |
| 3-4 | 員工不可建立 | emp token | `POST /departments` | 403 `forbidden` | PASS |

### 4. 員工 employees 生命週期 + RBAC

| # | 測試案例 | 前置 | 步驟 | 預期 | 實際 |
| --- | --- | --- | --- | --- | --- |
| 4-1 | HR 邀請（建）員工 | hr token | `POST /employees {email,name,password,deptId}` | 201；回傳 `employeeId`+`userId` | PASS |
| 4-2 | 列出員工 | 已建 | `GET /employees` | 200；含受邀者，且全部 `tenant_id`==A | PASS |
| 4-3 | 更新員工 | 已建 | `PATCH /employees/:id {empNo:"EMP-001"}` | 200 | PASS |
| 4-4 | 停用員工 | 已建 | `POST /employees/:id/deactivate` | 200；`status="inactive"` | PASS |
| 4-5 | 員工不可建立員工 | emp token | `POST /employees` | 403 | PASS |

### 5. 班別 shifts

| # | 測試案例 | 前置 | 步驟 | 預期 | 實際 |
| --- | --- | --- | --- | --- | --- |
| 5-1 | 建立班別 | hr token | `POST /shifts {name,startTime:"09:00",endTime:"18:00",breakMinutes:60}` | 201；`id` | PASS |
| 5-2 | 列出班別 | 已建 | `GET /shifts` | 200；含新班別 | PASS |
| 5-3 | 更新班別 | 已建 | `PATCH /shifts/:id {breakMinutes:45}` | 200 | PASS |

> 原 5-4～5-6（指派排班、HR 查全部排班、員工只見自己的排班；`POST`／`GET /schedules`）已刪除：班表（排班）功能
> 2026-10-11 移除，端點現在是 404。`live-e2e.mjs` 對應的步驟（共 6 個斷言）一併拿掉。

### 6. 打卡 punch（含防代打）

| # | 測試案例 | 前置 | 步驟 | 預期 | 實際 |
| --- | --- | --- | --- | --- | --- |
| 6-1 | 員工上班打卡 | emp token | `POST /punch {type:"in"}` | 201；`type:"in"`+`punchAt` | PASS |
| 6-2 | 今日狀態 | 已打 in | `GET /punch/today` | 200；`status:"working"`、>=1 筆 | PASS |
| 6-3 | 員工下班打卡 | emp token | `POST /punch {type:"out"}` | 201；`type:"out"` | PASS |
| 6-4 | HR 查指定員工打卡 | hr token | `GET /punch?employeeId=...` | 200；全部屬該員工 | PASS |
| 6-5 | 防代打（body 夾帶他人 employeeId 應被忽略） | emp token | `POST /punch {type:"in",employeeId:mgrId}` 後查 mgr `/punch/today` | 201；經理今日 0 筆（打卡落在本人） | PASS |

### 7. 假別 + 簽核流程 + 請假單生命週期

| # | 測試案例 | 前置 | 步驟 | 預期 | 實際 |
| --- | --- | --- | --- | --- | --- |
| 7-1 | 建立假別 | hr token | `POST /leave-types {code:"annual",name:"特休",paid:true}` | 201；`id` | PASS |
| 7-2 | 員工可讀假別 | emp token | `GET /leave-types` | 200；含特休 | PASS |
| 7-3 | 假別 code 重複 | 同 code | `POST /leave-types {code:"annual"}` | 409 `code_already_exists` | PASS |
| 7-4 | 設定 leave 簽核流程 → 經理 | hr token | `PUT /approval-flows/leave {approverEmpIds:[mgrId]}` | 200；`appliesTo:"leave"`、approver=mgr | PASS |
| 7-5 | 無效 kind | hr token | `PUT /approval-flows/nonsense` | 400 `invalid_kind` | PASS |
| 7-6 | 設定假別額度 | hr token | `PUT /leave-balances {employeeId,leaveTypeId,year,entitled:80}` | 200 | PASS |
| 7-7 | 員工送出請假單（8h，導向經理） | emp token | `POST /requests {kind:"leave",leaveTypeId,startAt,endAt,hours:8}` | 201；`requestId`、step1 approver=mgr | PASS |
| 7-8 | 申請人可見自己單 | emp token | `GET /requests` | 200；含該單 | PASS |
| 7-9 | 經理可見待簽單 | mgr token | `GET /requests?status=pending` | 200；含該單 | PASS |
| 7-10 | 申請人不可簽自己單 | emp token | `POST /requests/:id/approve` | 403 `not_current_approver` | PASS |
| 7-11 | 經理核准（單關 → approved） | mgr token | `POST /requests/:id/approve {comment}` | 200；`status:"approved"` | PASS |
| 7-12 | 重複核准 | mgr token | 再 `POST .../approve` | 409 `not_pending` | PASS |
| 7-13 | 經理駁回（第二張單） | mgr token | `POST /requests/:id2/reject {comment}` | 200；`status:"rejected"` | PASS |
| 7-14 | 非申請人不可取消 | mgr token | `POST /requests/:id3/cancel` | 403 `not_the_filer` | PASS |
| 7-15 | 申請人取消（第三張單） | emp token | `POST /requests/:id3/cancel` | 200；`status:"cancelled"` | PASS |

### 8. 公告 announcements CRUD

| # | 測試案例 | 前置 | 步驟 | 預期 | 實際 |
| --- | --- | --- | --- | --- | --- |
| 8-1 | 建立公告 | hr token | `POST /announcements {title,body}` | 201；`id` | PASS |
| 8-2 | 員工可讀 | emp token | `GET /announcements` | 200；含該公告 | PASS |
| 8-3 | 更新公告 | 已建 | `PATCH /announcements/:id {title}` | 200 | PASS |
| 8-4 | 刪除公告 | 已建 | `DELETE /announcements/:id` | 200 | PASS |
| 8-5 | 員工不可建立 | emp token | `POST /announcements` | 403 | PASS |

### 9. 規則設定 + 薪資 + 出勤結算 + 薪資批次

| # | 測試案例 | 前置 | 步驟 | 預期 | 實際 |
| --- | --- | --- | --- | --- | --- |
| 9-1 | 設定規則（weekday_ot compTime:true） | hr token | `PUT /rule-config {…overtime.rules[weekday_ot].compTime:true…}` | 200；回傳 `version` | PASS |
| 9-2 | 讀回規則 | 已設 | `GET /rule-config` | 200；`config.overtime.rules[0].compTime==true` | PASS |
| 9-3 | 員工可讀規則 | emp token | `GET /rule-config` | 200 | PASS |
| 9-4 | 設定薪資結構 | hr token | `PUT /salary/:employeeId {method:"monthly",baseSalary:36000,hourlyWage:200}` | 200 | PASS |
| 9-5 | 讀回薪資 | 已設 | `GET /salary/:employeeId` | 200；`base_salary==36000` | PASS |
| 9-6 | 出勤結算（今日） | 員工今日已 in+out | `POST /attendance/settle {employeeId,from,to}` | **200**；`settled>=1` | PASS |
| 9-7 | 查出勤日 | 已結算 | `GET /attendance-days?employeeId&from&to` | 200；含今日 work_date | PASS |
| 9-8 | 薪資批次（首跑） | 薪資+出勤 | `POST /payroll/run {employeeId,period}` | 201；`generated>=1` | PASS |
| 9-9 | 查薪資單 | 已跑 | `GET /payslips?employeeId&period` | 200；`status:"draft"` | PASS |
| 9-10 | 草稿重跑不跳過 | draft | 再 `POST /payroll/run` | 201；`skipped` 為空 | PASS |
| 9-11 | 定版薪資單 | draft | `POST /payslips/:id/finalize` | 200；`status:"finalized"` | PASS |
| 9-12 | 重複定版 | finalized | 再 finalize | 409 `already_finalized` | PASS |
| 9-13 | 定版後重跑 → 跳過 | finalized | `POST /payroll/run` | 201；`skipped` 含該員工、`generated==0` | PASS |

### 10. 假別餘額 used 累加 + 補休累積 + 調整

| # | 測試案例 | 前置 | 步驟 | 預期 | 實際 |
| --- | --- | --- | --- | --- | --- |
| 10-1 | 請假核准後 used 增加 | 7-11 已核准 8h 假 | `GET /leave-balances?employeeId&year` | 200；`used==8`、`entitled==80`（保留） | PASS |
| 10-2 | OT 核准 → 補休累積 | 規則 compTime:true、ot 流程導向經理 | `POST /requests {kind:"ot",hours:3}` → 經理核准 | 201/200；approved | PASS |
| 10-3 | 補休結餘正確 | OT 已核准 | `GET /comp-time?employeeId` | 200；`balance==3`；ledger 來源為該 OT 單 | PASS |
| 10-4 | 補休手動調整（用掉 1h） | 結餘 3 | `POST /comp-time/adjust {employeeId,hoursUsed:1}` | 201 | PASS |
| 10-5 | 調整後結餘 | 已調整 | `GET /comp-time` | `balance==2` | PASS |

### 11. 報表 reports（含 CSV）+ RBAC

| # | 測試案例 | 前置 | 步驟 | 預期 | 實際 |
| --- | --- | --- | --- | --- | --- |
| 11-1 | 出勤報表 | hr token | `GET /reports/attendance?from&to` | 200；`rows[]` | PASS |
| 11-2 | 出勤報表 CSV | hr token | `GET /reports/attendance?...&format=csv` | 200；`Content-Type: text/csv`；含表頭 `employeeId` | PASS |
| 11-3 | 薪資報表 | hr token | `GET /reports/payroll?period` | 200；`total.gross` 為數字 | PASS |
| 11-4 | 請假報表 | hr token | `GET /reports/leave?from&to` | 200；`rows[]`+`details[]` | PASS |
| 11-5 | 人數報表 | hr token | `GET /reports/headcount` | 200；`total`+`byStatus`+`byRole` | PASS |
| 11-6 | 員工不可看報表 | emp token | `GET /reports/attendance` | 403 | PASS |

### 12. KPI 範本 + 考核 kpi-reviews（加權總分）

| # | 測試案例 | 前置 | 步驟 | 預期 | 實際 |
| --- | --- | --- | --- | --- | --- |
| 12-1 | 建立 KPI 範本 | hr token | `POST /kpi-templates {items:[品質 w60/max10, 態度 w40/max10]}` | 201；`id` | PASS |
| 12-2 | 員工可讀範本 | emp token | `GET /kpi-templates` | 200；含該範本 | PASS |
| 12-3 | 指派考核（員工←經理評） | hr token | `POST /kpi-reviews {employeeId,reviewerEmpId:mgr,templateId,period}` | 201；`id` | PASS |
| 12-4 | 重複指派 | 同組合 | 再 `POST /kpi-reviews` | 409 `review_already_exists` | PASS |
| 12-5 | 經理評分（加權總分） | 已指派 | `PATCH /kpi-reviews/:id {scores:[品質8,態度9]}` | 200；`totalScore==84`（8/10×60+9/10×40） | PASS |
| 12-6 | 員工不可評分 | emp token | `PATCH /kpi-reviews/:id` | 403 `not_the_appraiser` | PASS |
| 12-7 | 經理送出 | draft | `POST /kpi-reviews/:id/submit` | 200；`status:"submitted"` | PASS |
| 12-8 | 受評者定版前看不到 | emp token | `GET /kpi-reviews` | 200；清單不含該（submitted）考核 | PASS |
| 12-9 | 經理不可定版 | mgr token | `POST /kpi-reviews/:id/finalize` | 403 `forbidden` | PASS |
| 12-10 | HR 定版 | submitted | `POST /kpi-reviews/:id/finalize` | 200；`status:"finalized"` | PASS |
| 12-11 | 定版後受評者可見 | emp token | `GET /kpi-reviews` | 含該已定版考核 | PASS |

### 13. 偵測 detection → 通知 notifications

> 路由實際掛載於 `/attendance/*`（非 `/detection/*`）。

| # | 測試案例 | 前置 | 步驟 | 預期 | 實際 |
| --- | --- | --- | --- | --- | --- |
| 13-1 | 缺卡掃描（只 in 未 out） | 另建員工，用 service_role 直接寫一列當日 `schedules`（`POST /schedules` 已移除；缺卡掃描讀班表的分支保留給歷史資料），今日只打 in | `POST /attendance/scan-missing-punch {date:今日}` | 200；`missing` 含該員工 `issue:"no_out"` | PASS |
| 13-2 | 產生通知 | 13-1 | 同上回應 | `queued>=1` | PASS |
| 13-3 | 重掃冪等 | 13-1 已掃 | 再掃同日 | `queued==0` | PASS |
| 13-4 | HR 看全部通知 | hr token | `GET /notifications` | 200；含該 `missing_punch` 通知 | PASS |
| 13-5 | 員工只看自己通知 | 缺卡員工 token | `GET /notifications` | 200；全部屬本人、含自己缺卡通知 | PASS |
| 13-6 | 標記已讀 | 有通知 | `POST /notifications/:id/read` | 200；`read:true` | PASS |
| 13-7 | 異常偵測 | hr token | `GET /attendance/anomalies?from&to` | 200；`anomalies[]` | PASS |
| 13-8 | 遲到統計 | hr token | `GET /attendance/late-stats?from&to` | 200；`rows[]` | PASS |
| 13-9 | 員工不可看異常 | emp token | `GET /attendance/anomalies` | 403 | PASS |

### 14. 跨租戶隔離（A vs B）

| # | 測試案例 | 前置 | 步驟 | 預期 | 實際 |
| --- | --- | --- | --- | --- | --- |
| 14-1 | A 員工清單不含 B | 另建租戶 B | A.hr `GET /employees` | 全部 `tenant_id`==A，不含 B 員工 | PASS |
| 14-2 | A 看不到 B 部門 | B 已建部門 | A.hr `GET /departments` | 不含 B 部門 | PASS |
| 14-3 | A 不可改 B 部門 | B 部門 id | A.hr `PATCH /departments/:bDeptId` | 404（租戶隔離） | PASS |
| 14-4 | A branding 為 A 自己 | — | A.hr `GET /api/tenant/branding` | `appName`==A 名稱 | PASS |

### 清理（TEARDOWN）

| # | 測試案例 | 步驟 | 預期 | 實際 |
| --- | --- | --- | --- | --- |
| T-1 | 依 FK 序清空所有建立資料 | 對每個建立的租戶，依序刪 `approval_steps→comp_time_ledger→leave_requests→…→employees→departments→tenants`，再刪 auth 使用者 | cleanup errors 0 | PASS |
| T-2 | 零殘留驗證 | 重查自己建立的租戶/員工/使用者 | 殘留 0（獨立複查租戶與員工總數回到基線） | PASS |

---

## 已知行為備註（供前端對接）

- `POST /attendance/settle` 成功回 **200**（非 201），body `{ settled: <number> }`。
- 偵測端點掛在 `/attendance/scan-missing-punch`、`/attendance/anomalies`、`/attendance/late-stats`。
- KPI 評分用 `PATCH /kpi-reviews/:id`（非 `/score`）；加權總分公式 `Σ (score/maxScore) × weight`，四捨五入 2 位。
- 簽核流程 `kind` 與請假單 `kind` 列舉皆為 `leave | ot | fix_punch`（加班用 `ot`，非 `overtime`）。
- 角色寫入端點回 403 時 body 多為 `{ error: "forbidden" }`；流程相關權限錯誤為 `not_current_approver` / `not_the_filer` / `not_the_appraiser`。
- 報表 CSV 採 UTF-8 BOM + CRLF（Excel 中文相容），`Content-Disposition: attachment`。

---

## 前台 / 後台 UI 測試（待補）

> 以下為前端介面層測試區塊，後續補上。

### 前台（員工自助 ESS）UI 測試
- （待補）登入 / 登出
- （待補）打卡（上下班、定位/裝置）
- （待補）請假 / 加班 / 補卡申請與進度查詢
- （待補）薪資單檢視
- （待補）通知中心與已讀
- （待補）KPI 考核結果檢視（定版後）

### 後台（HR / 管理員）UI 測試
- （待補）員工 / 部門 / 班別管理介面
- （待補）簽核流程設定與簽核作業
- （待補）規則設定（差勤 / 薪資 DSL）
- （待補）出勤結算 / 薪資批次 / 定版
- （待補）報表檢視與 CSV 匯出
- （待補）缺卡掃描 / 異常偵測 / 遲到統計儀表
- （待補）KPI 範本與考核指派 / 定版
- （待補）白標 branding 設定
