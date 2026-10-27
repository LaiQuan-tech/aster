import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  // apps/web 的元件測試（*.test.tsx）用到 Next 的 `@/` 路徑別名；只對「@/」開頭生效，不影響 @hr/* 套件。
  resolve: {
    alias: [{ find: /^@\//, replacement: fileURLToPath(new URL("./apps/web/src/", import.meta.url)) }],
  },
  test: {},
});
