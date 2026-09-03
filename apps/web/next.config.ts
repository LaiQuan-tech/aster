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

const nextConfig: NextConfig = {};

export default nextConfig;
