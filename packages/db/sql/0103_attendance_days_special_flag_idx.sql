-- 2026-11-17 特殊假日旗標的 partial index（本檔 ＝ migrations/0113；接 sql/0102）。
--
-- settleAttendance 每次結算前查「區間內有沒有帶 anomaly.flags.specialDay 的列」（limit 1），有才跑殘留清理
-- （刪除特殊假日後重算失敗、之後手動重算／每日排程也清得掉）。只索引帶旗標的列，平常幾乎是空的。
-- 另：0111 的重算鎖殘留接手時間由 API 改為 2 分鐘（routes/special-leave-days.ts STALE_LOCK_MS；表結構不變）。
-- 純新增、可重跑；不動任何資料列。

CREATE INDEX IF NOT EXISTS attendance_days_special_flag_idx
  ON public.attendance_days (tenant_id, work_date)
  WHERE (anomaly -> 'flags' -> 'specialDay') IS NOT NULL;
