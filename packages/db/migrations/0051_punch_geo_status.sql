ALTER TABLE "punch_records" ADD COLUMN IF NOT EXISTS "geo_status" text;--> statement-breakpoint
-- 定位失敗原因；只在沒有 lat/lng 時才寫，有座標一律 null（apps/api/src/routes/punch.ts
-- POST /punch）。合法值：denied 使用者拒絕權限｜unavailable 裝置拿不到位置｜timeout 定位
-- 逾時｜unsupported 裝置/瀏覽器不支援 geolocation。DROP+ADD 可重跑（同 sql/0040 CHECK 寫法）。
ALTER TABLE "punch_records" DROP CONSTRAINT IF EXISTS "punch_records_geo_status_chk";--> statement-breakpoint
ALTER TABLE "punch_records" ADD CONSTRAINT "punch_records_geo_status_chk"
  CHECK ("geo_status" IS NULL OR "geo_status" IN ('denied', 'unavailable', 'timeout', 'unsupported'));