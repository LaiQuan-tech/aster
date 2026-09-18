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
];

const nextConfig: NextConfig = {
  async redirects() {
    return ADMIN_REDIRECTS.map((redirect) => ({ ...redirect, permanent: false }));
  },
};

export default nextConfig;
