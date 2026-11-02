# MCP 連接教學：用 Claude／ChatGPT 以自己的身分操作亞斯特

> 2026-11-02 上線。AI 以**你本人**的身分操作系統：權限與你在後台完全相同（HR 只能做 HR 的事、老闆關只有平台管理員能簽、不能簽自己的單……既有規則全部沿用），每筆操作都記在你名下，稽核紀錄標示「經由 MCP＋哪個 AI 工具」，隨時可撤銷。

## 連接網址

```
https://aster-hr-api.vercel.app/mcp
```

後台「設定 → AI 連接」也看得到這個網址（可一鍵複製）。

---

## 1. claude.ai／Claude 桌面版（自訂連接器）

1. 打開 claude.ai（或 Claude 桌面版）→ 左下角頭像 → **設定 → 連接器（Connectors）**。
2. 按 **新增自訂連接器（Add custom connector）**。
   - Team／Enterprise 方案要由組織管理員先在「組織設定 → 連接器」加入，成員再到自己的設定按「連接」。
3. 名稱填「亞斯特」，網址貼上 `https://aster-hr-api.vercel.app/mcp`。進階設定（OAuth Client ID／Secret）**留空**，系統會自動註冊。
4. 按 **連接** → 跳到亞斯特登入頁 → 用你平常的帳號登入 → 同意頁會寫「Claude 想以你的身分操作亞斯特（權限同你的後台權限）」→ 按 **同意**。
5. 回到 Claude，對話框的「工具」裡把亞斯特打開即可使用，例如：「列出待我簽核的單」、「這個月誰還沒交出勤月表」。

## 2. ChatGPT（開發者模式 connector）

1. ChatGPT → **設定 → 應用程式與連接器（Apps & Connectors）→ 進階設定 → 開啟「開發者模式」**（需 Plus／Pro／Business／Enterprise，企業版由管理員開放）。
2. 回到「應用程式與連接器」→ **建立（Create）**。
3. 名稱「亞斯特」，MCP 伺服器網址貼 `https://aster-hr-api.vercel.app/mcp`，認證選 **OAuth**，用戶端 ID／密鑰留空（自動註冊）。
4. 勾選「我信任這個應用程式」→ 建立 → 跳到亞斯特登入並按 **同意**。
5. 新對話 → 「+」→ 開發者模式 → 選亞斯特。

## 3. Claude Code（個人存取金鑰）

1. 後台 **設定 → AI 連接 → 個人存取金鑰**：輸入名稱（例：我的筆電）、選有效期限 → **產生金鑰**。
   有效期限可選 30／90／180／365 天（API 接受 1–365 天，預設 90 天）。
   金鑰**只顯示這一次**，請立刻複製；遺失就撤銷再產生一把。系統只存雜湊，任何人（含管理員）都看不到原文。
2. 終端機執行：

```bash
claude mcp add --transport http aster https://aster-hr-api.vercel.app/mcp \
  --header "Authorization: Bearer <你的金鑰>"
```

3. 在 Claude Code 裡打 `/mcp` 確認「aster」是 connected。
   - 不想用金鑰也可以不加 `--header`，Claude Code 會走 OAuth（開瀏覽器登入同意）。

---

## 能做什麼

- 高階工具（中文描述，AI 會自己挑）：查待確認操作、我是誰、查員工、員工個人資料、部門、打卡紀錄、出勤當日總覽、出勤異常、查申請單、**待我簽核**（申請單＋放款單＋獎金批次）、**簽核申請單**、批次簽核、假別餘額、專案清單／明細、放款單清單／明細／簽核、薪資單、發薪前檢查、報表、獎金批次、稽核紀錄、我的通知。
- 全部功能：`list_endpoints`（列出系統所有 API 與說明，可用關鍵字篩選）＋ `call_api`（以你的身分呼叫任一 API）。
- 回應會分頁／截斷（預設 50 筆），AI 會自己帶 `offset` 翻頁；檔案下載類（xlsx）只回檔案資訊，請到後台下載。

## 危險操作：兩級確認

### 第一級（最高風險）：一定要你本人在後台按「確認執行」

AI **不能自己完成**這些動作。它第一次呼叫只會建立一筆「待確認操作」，並給你一個網址
`https://aster-system.vercel.app/mcp/confirm/<id>`。你登入後會看到完整內容（哪支 API、查詢參數、送出的資料），按 **確認執行** 或 **拒絕**。
確認時系統以**你此刻的身分與權限**重新檢查後才執行，結果存起來，AI 可以用 `get_pending_action` 查狀態與結果。
待確認操作 10 分鐘內有效、只能決定一次、只有你本人看得到；後台「設定 → AI 連接 → 待確認操作」也列得到。

- 薪資：執行薪資計算、薪資單定案／寄送／批次寄送、完成本月發薪（鎖定）、**重新開放期間**
- 金流：**放款**、批次放款、**作廢**放款單；新增／修改廠商（收款帳號）；修改員工個人資料（含銀行帳號）、核准員工改資料
- 獎金：獎金批次**核准／發放／沖回**；新增／修改薪資調整
- 權限與帳號：變更員工角色／權限／在職狀態／離職日／所屬公司、新增員工、停用帳號、重設密碼、寄重設密碼信、變更部門主管（影響簽核鏈）
- 規則設定：規則參數、簽核流程；新增租戶
- **所有刪除（DELETE）**

### 第二級（中風險）：對話裡確認（confirm_token）

AI 第一次呼叫只回「將要做什麼」的預覽和一組 `confirm_token`，你在對話裡同意後，AI 帶著 token 以**完全相同的參數**再呼叫一次才執行。
confirm_token 5 分鐘內有效、只能用一次、綁定你本人與這個連線，參數有任何不同就作廢。

- 薪資／獎金／放款／三節獎金／加班超額另計／薪資結構／預支／報銷月結／特休結算／扣繳等路徑底下**所有其他寫入**（保守規則：新端點也自動算；一般的放款單送簽／核准／駁回除外）
- 出勤：核定或重開出勤月表、出勤結算、補登打卡（含批次匯入）、掃描缺卡、修改行事曆日別、重新產生行事曆／國定假日
- 專案：分潤修訂、專案成員增改、請款期程／主合約／複委託修改、複委託付款驗收、請款、開發票、入帳與各種取消
- 其他：批次簽核、變更簽核人、假別增改、假別額度與特休發放、補休調整、公司／報銷／專案設定、Excel 批次匯入、發布或修改公告、寄出待送通知與催辦、員工信箱、值日表產生、KPI 定案、備份

完整清單在程式 `apps/api/src/services/mcp/danger.ts`。

## 怎麼撤銷

- **後台 設定 → AI 連接**：
  - 「個人存取金鑰」→ 撤銷：該金鑰立即失效。
  - 「已授權的 AI 應用」→ 撤銷：claude.ai／ChatGPT 的連線立即失效，要用得重新連接並按同意。
- 改密碼或被重設密碼：你所有的 AI 授權與個人金鑰立即撤銷，需要重新連接。
- 帳號被停用（員工狀態非在職）或 Supabase 帳號停權、換公司：所有 AI 連線**下一個請求就失效**（每次請求都重新檢查，不靠 token 裡的快取）。
- 角色被調降：下一個請求就只剩新角色的權限。

## 稽核

- 經 AI 的每一筆寫入都會在稽核紀錄多一列 `mcp_calls`（誰、哪個 AI 工具、哪支 API、結果），被改的資料表本身的稽核列 context 也會以 `[mcp:<工具名>]` 開頭。後台 **系統 → 稽核紀錄** 篩選資料表 `mcp_calls` 即可只看 AI 操作。
- 授權、產生／撤銷金鑰也有稽核紀錄（`mcp_grants`）。

---

## 技術附錄（給維運）

| 項目 | 內容 |
|---|---|
| MCP 端點 | `POST /mcp`（Streamable HTTP、stateless、回 JSON）；GET／DELETE 回 405。單一工具呼叫總截止 50 秒。SDK `@modelcontextprotocol/sdk` 1.32.2，支援 protocol 2025-11-25／2025-06-18／2025-03-26／2024-11-05 |
| 認證 | OAuth 2.1：RFC 9728（`/.well-known/oauth-protected-resource[/mcp]`）、RFC 8414（`/.well-known/oauth-authorization-server`）、RFC 7591 DCR（`/oauth/register`）、PKCE S256 必須、refresh token 輪替（重放即撤銷整個授權）、RFC 7009 撤銷（`/oauth/revoke`）、RFC 8707 resource 檢查、回 `iss`（RFC 9207）。401 帶 `WWW-Authenticate: Bearer resource_metadata=…` |
| 同意頁 | `https://aster-system.vercel.app/oauth/consent`（API `/oauth/authorize` 驗完參數後 302 過來） |
| token | access 1 小時、refresh 30 天（輪替）、個人金鑰 1–365 天（預設 90 天）。DB 只存 HMAC-SHA256 雜湊。改密碼／重設密碼時撤銷該使用者所有授權與金鑰 |
| 身分派送 | MCP 工具在同一程序內以一次性內部 token 打既有 Express routes（`services/mcp/dispatch.ts`），權限與業務邏輯一行都不複製 |
| Origin | 有帶 Origin 必須是 claude.ai／claude.com／chatgpt.com／後台網域（或 `MCP_ALLOWED_ORIGINS`）；沒帶（伺服器對伺服器）放行 |
| 環境變數（aster-hr-api） | `MCP_TOKEN_SECRET`（必要，≥32 字；沒設則 MCP 全部 503）、`MCP_PUBLIC_URL`（API 對外網址）、既有 `WEB_URL`／`WEB_ORIGINS` |
| 資料表 | migration 0082（sql/0072）：`mcp_oauth_clients`、`mcp_grants`、`mcp_tokens`、`mcp_oauth_codes`、`mcp_confirmations`；0083（sql/0073）：`mcp_pending_actions`。RLS 開、無 policy、anon／authenticated 無權限 |
| 路徑檢查 | call_api 的 path 必須是標準形式（不含 %、dot-segment、反斜線、控制字元，URL 解析後不變），危險／封鎖比對不分大小寫 |
| 動態註冊 | 用戶端總數上限 1000，90 天沒用的在註冊時清掉 |
| 同意頁 | redirect 網域不是 claude.ai／claude.com／chatgpt.com／本機 → 紅色「未驗證的應用」；名稱含 Claude／ChatGPT 等但網域不符 → 標「名稱與網域不符」 |
| claude.ai redirect URI | `https://claude.ai/api/mcp/auth_callback`（DCR 時由 Claude 自己註冊，精確比對） |
| ChatGPT redirect URI | `https://chatgpt.com/connector_platform_oauth_redirect`（DCR 時由 ChatGPT 自己註冊） |
