import type { PunchRecord } from "./admin-api";

/**
 * 後台打卡紀錄「地點」欄：沒有座標時要顯示原因，不能只有一個「—」
 * （2026-09-30 業主追加需求）。只在呼叫端已經確認 `lat`/`lng` 缺席時呼叫——這支
 * 函式本身不重複判斷有沒有座標，一律回傳一個原因字串。
 *
 * 判斷順序：
 *   1. `source` = manual（人工補登）／line（LINE 打卡）——這兩種管道本來就不會
 *      有座標，原因跟 `geo_status` 無關，寫死。
 *   2. 其餘（主要是 source=web）依 `geo_status` 四種定位失敗原因逐一對應中文；
 *      不是這四種（含 null——2026-09-30 之前的舊資料，這欄那時還不存在）一律回
 *      「未取得定位」。
 */
export function punchLocationReason(record: Pick<PunchRecord, "source" | "geo_status">): string {
  if (record.source === "manual") return "人工補登";
  if (record.source === "line") return "LINE 打卡";
  switch (record.geo_status) {
    case "denied":
      return "未開啟定位權限";
    case "unavailable":
      return "手機無法取得位置";
    case "timeout":
      return "定位逾時";
    case "unsupported":
      return "裝置不支援定位";
    default:
      return "未取得定位";
  }
}
