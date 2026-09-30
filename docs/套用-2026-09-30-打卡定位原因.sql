-- =====================================================================
-- 亞斯特 — 2026-09-30 打卡定位失敗原因（migration 0051）
--
-- 業主追加需求（F）：後台打卡紀錄「地點」欄沒有座標時要顯示原因，員工端要把
-- 定位失敗的原因（使用者拒絕權限／裝置拿不到位置／逾時／裝置不支援定位）
-- 一併記下來，不能只顯示「—」。
--
-- 內容（＝ migration 0051，drizzle-kit generate 自動產生 ADD COLUMN，CHECK 手動補）：
--   punch_records 加欄 geo_status text（可為 null）＋ CHECK（null 或
--   'denied'｜'unavailable'｜'timeout'｜'unsupported' 四值之一）。
--
-- 前提：正式庫已套到 migration 0050 ＋ sql/0041（2026-09-23 需求補齊之後；
-- 同日 A–E 幾項打卡紀錄／員工列表的後台、前台改動都不碰 DB，本檔是這之後
-- 第一支新 migration）。
--
-- 套用方式：scratchpad/mgmt-query.sh（Supabase Management API，單一交易）
-- 或 Supabase SQL Editor 手動貼上執行。
--
-- 冪等：ADD COLUMN IF NOT EXISTS；CHECK 用 DROP CONSTRAINT IF EXISTS ＋ ADD
-- CONSTRAINT（同 sql/0040 [D] 的寫法），可重複執行不出錯。已用
-- packages/db/scripts/replay-on-pglite.mjs 在 pglite 上重建到 migration 0050 ＋
-- sql 全部 41 支之後套用本檔兩次驗證冪等，全部通過（✅ 全部通過，無失敗）。
--
-- 部署順序：**先把本檔套到正式庫，確認欄位與 CHECK 都在，才可以 push 會讀寫
-- geo_status 的程式**——apps/api/src/routes/punch.ts（POST /punch 寫入、
-- SELECT_COLS 讀出）、apps/web/src/app/ess/page.tsx（送出 geoStatus）、
-- apps/web/src/lib/ess-api.ts（postPunch 參數）、apps/web/src/lib/admin-api.ts
-- （PunchRecord 型別）、apps/web/src/app/admin/punch-records/page.tsx（顯示原因）。
-- 欄位未建就先部署 API 會讓 GET／POST /punch 因未知欄位或 CHECK 違反而出錯，
-- 打卡功能全公司一起壞掉；反過來，本檔套用當下既有 API 一律不讀不寫這個新
-- 欄位，對既有流量無感、可以先套。
--
-- 還原（不可逆前先確認沒有程式在讀寫這欄位）：
--   ALTER TABLE punch_records DROP CONSTRAINT IF EXISTS punch_records_geo_status_chk;
--   ALTER TABLE punch_records DROP COLUMN IF EXISTS geo_status;
-- =====================================================================

ALTER TABLE "punch_records" ADD COLUMN IF NOT EXISTS "geo_status" text;

-- 定位失敗原因；只在沒有 lat/lng 時才寫，有座標一律 null（apps/api/src/routes/punch.ts
-- POST /punch）。合法值：denied 使用者拒絕權限｜unavailable 裝置拿不到位置｜timeout 定位
-- 逾時｜unsupported 裝置/瀏覽器不支援 geolocation。
ALTER TABLE "punch_records" DROP CONSTRAINT IF EXISTS "punch_records_geo_status_chk";
ALTER TABLE "punch_records" ADD CONSTRAINT "punch_records_geo_status_chk"
  CHECK ("geo_status" IS NULL OR "geo_status" IN ('denied', 'unavailable', 'timeout', 'unsupported'));
