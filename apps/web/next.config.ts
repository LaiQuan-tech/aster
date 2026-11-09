import type { NextConfig } from "next";
import { resolve } from "node:path";
import dotenv from "dotenv";

// Next.js 只讀取 apps/web/ 自己的 .env，不會往上找 monorepo 根目錄。
// apps/api 與 apps/worker 都載入 repo 根的同一份 .env（見 api/src/index.ts），
// web 沿用同樣來源，避免同一組憑證維護兩份。
// 用 process.cwd()（next dev/build 時為 apps/web）而非 import.meta.url——
// next.config.ts 會被編譯成 CJS，ESM-only 的 import.meta 在其中無法執行。
// 線上（Vercel）由平台注入環境變數，讀不到此檔也不影響。
dotenv.config({ path: resolve(process.cwd(), "../../.env") });

/**
 * 後台舊網址轉址（2026-09 後台簡化：表單紀錄併入簽核頁、組織圖併入部門頁）。
 * 必須與 src/lib/admin-nav.ts 的 ADMIN_REDIRECTS 一致——Next 只單獨編譯 next.config.ts，
 * 相對 import 的 .ts 檔在執行期會 Cannot find module，所以這裡不能直接 import，
 * 改由 src/lib/__tests__/admin-nav.test.ts 對照兩份。permanent:false（307）：舊頁面
 * 刪除前後都還能回頭調整，瀏覽器不會把轉址快取死。
 */
const ADMIN_REDIRECTS = [
  { source: "/admin/form-records", destination: "/admin/approvals?status=all" },
  { source: "/admin/org-chart", destination: "/admin/departments" },
  { source: "/admin/onboarding", destination: "/admin/employees" },
  { source: "/admin/birthday-gifts", destination: "/admin/employees" },
  { source: "/admin/projects/overview", destination: "/admin/projects" },
  { source: "/admin/projects/annual", destination: "/admin/projects" },
  { source: "/admin/projects/alerts", destination: "/admin/projects" },
  { source: "/admin/stamp-duty", destination: "/admin/projects" },
  { source: "/admin/group-overview", destination: "/admin#group-overview" },
  { source: "/admin/bonus-runs", destination: "/admin/bonus-sheet" },
  { source: "/admin/projects/receivables", destination: "/admin/disbursements?view=receivables" },
  { source: "/admin/attendance-sheets", destination: "/admin/attendance-statements" },
  { source: "/admin/attendance-sheets/:id", destination: "/admin/attendance-statements?sheet=:id" },
  { source: "/admin/late-reports", destination: "/admin/punch-records?view=late" },
  { source: "/admin/payslips", destination: "/admin/payroll" },
  { source: "/admin/payroll-tax", destination: "/admin/expenses?section=tax" },
  { source: "/admin/festival-bonuses", destination: "/admin/expenses?section=festival" },
  { source: "/admin/overtime-settlements", destination: "/admin/expenses?section=overtime" },
  { source: "/admin/advances", destination: "/admin/expenses?section=advances" },
];

const nextConfig: NextConfig = {
  async redirects() {
    return ADMIN_REDIRECTS.map((redirect) => ({ ...redirect, permanent: false }));
  },
  // AI 連接的 OAuth 同意頁與高風險操作確認頁（2026-11-02）不得被別的網站嵌在 iframe 裡（防點擊劫持騙按「同意／確認執行」）。
  async headers() {
    return [
      ...["/oauth/:path*", "/mcp/:path*"].map((source) => ({
        source,
        headers: [
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Content-Security-Policy", value: "frame-ancestors 'none'" },
          { key: "Referrer-Policy", value: "no-referrer" },
        ],
      })),
    ];
  },
};

export default nextConfig;
