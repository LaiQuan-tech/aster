import { describe, it, expect } from "vitest";
import { punchLocationReason } from "../punch-location-reason";

describe("punchLocationReason — 後台打卡紀錄地點欄沒座標時的原因文字", () => {
  it("source=manual（人工補登）→ 人工補登，不管 geo_status", () => {
    expect(punchLocationReason({ source: "manual", geo_status: null })).toBe("人工補登");
    expect(punchLocationReason({ source: "manual", geo_status: "denied" })).toBe("人工補登");
  });

  it("source=line（LINE 打卡）→ LINE 打卡，不管 geo_status", () => {
    expect(punchLocationReason({ source: "line", geo_status: null })).toBe("LINE 打卡");
  });

  it("source=web 依 geo_status 四種定位失敗原因逐一對應", () => {
    expect(punchLocationReason({ source: "web", geo_status: "denied" })).toBe("未開啟定位權限");
    expect(punchLocationReason({ source: "web", geo_status: "unavailable" })).toBe("手機無法取得位置");
    expect(punchLocationReason({ source: "web", geo_status: "timeout" })).toBe("定位逾時");
    expect(punchLocationReason({ source: "web", geo_status: "unsupported" })).toBe("裝置不支援定位");
  });

  it("source=web 且 geo_status 為 null（欄位新增前的舊資料）→ 未取得定位", () => {
    expect(punchLocationReason({ source: "web", geo_status: null })).toBe("未取得定位");
  });

  it("其餘未預期組合（例如 source=gps 卻沒座標）保底回未取得定位，不會丟例外", () => {
    expect(punchLocationReason({ source: "gps", geo_status: null })).toBe("未取得定位");
  });
});
