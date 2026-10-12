import { describe, it, expect } from "vitest";
import {
  buildDayRows,
  fixPunchHref,
  fixPunchTypeOf,
  isFillDay,
  isWeekday,
  MAX_FILL_DAYS,
  type PunchHistoryRecord,
} from "../punch-history";

/**
 * 全部用 UTC ISO 輸入＋ tz:"Asia/Taipei"（UTC+8）：只要分組退回 `punch_at.slice(0, 10)`
 * 的 UTC 切片，跨日案例（16:30Z → 台北隔天 00:30）就會抓到。
 * 2026-09-14（一）～ 2026-09-18（五）是平日；09-12（六）、09-13（日）是週末。
 */
const TZ = "Asia/Taipei";

let seq = 0;
function rec(type: string, punchAt: string, source: string | null = "web"): PunchHistoryRecord {
  seq += 1;
  return { id: `r${seq}`, type, punch_at: punchAt, source };
}

describe("isWeekday", () => {
  it("週一～五為平日，週六日不是，無效日期不是", () => {
    expect(isWeekday("2026-09-14")).toBe(true); // 一
    expect(isWeekday("2026-09-18")).toBe(true); // 五
    expect(isWeekday("2026-09-12")).toBe(false); // 六
    expect(isWeekday("2026-09-13")).toBe(false); // 日
    expect(isWeekday("not-a-date")).toBe(false);
  });
});

describe("buildDayRows", () => {
  it("UTC 16:30 的打卡歸台北隔天（2026-09-17），不是 UTC 日期 09-16", () => {
    const r = rec("in", "2026-09-16T16:30:00Z");
    const rows = buildDayRows([r], "2026-09-17", "2026-09-17", TZ);
    expect(rows).toHaveLength(1);
    expect(rows[0].date).toBe("2026-09-17");
    expect(rows[0].in?.id).toBe(r.id);
    expect(rows[0].status).toBe("missing_out");
    expect(rows.find((row) => row.date === "2026-09-16")).toBeUndefined();
  });

  it("區間內每個平日都補一列（沒紀錄 → none、時長 null），並依日期降冪", () => {
    const rows = buildDayRows([], "2026-09-14", "2026-09-18", TZ);
    expect(rows.map((row) => row.date)).toEqual([
      "2026-09-18",
      "2026-09-17",
      "2026-09-16",
      "2026-09-15",
      "2026-09-14",
    ]);
    for (const row of rows) {
      expect(row.status).toBe("none");
      expect(row.durationMin).toBeNull();
      expect(row.in).toBeUndefined();
      expect(row.out).toBeUndefined();
    }
  });

  it("週六日不補空列，但有紀錄的週末會列出", () => {
    expect(buildDayRows([], "2026-09-12", "2026-09-13", TZ)).toEqual([]);

    // 2026-09-12T01:00Z = 台北週六 09:00
    const sat = rec("in", "2026-09-12T01:00:00Z");
    const rows = buildDayRows([sat], "2026-09-12", "2026-09-13", TZ);
    expect(rows.map((row) => row.date)).toEqual(["2026-09-12"]);
    expect(rows[0].status).toBe("missing_out");
  });

  it("只有下班 → missing_in；只有上班 → missing_out；兩者皆無時長", () => {
    const outOnly = rec("out", "2026-09-14T10:00:00Z"); // 週一 18:00
    const inOnly = rec("in", "2026-09-15T01:00:00Z"); // 週二 09:00
    const rows = buildDayRows([outOnly, inOnly], "2026-09-14", "2026-09-15", TZ);
    expect(rows.map((row) => [row.date, row.status, row.durationMin])).toEqual([
      ["2026-09-15", "missing_out", null],
      ["2026-09-14", "missing_in", null],
    ]);
    expect(rows[1].out?.id).toBe(outOnly.id);
    expect(rows[1].in).toBeUndefined();
    expect(rows[0].in?.id).toBe(inOnly.id);
    expect(rows[0].out).toBeUndefined();
  });

  it("時長＝out − in，跨 UTC 午夜但同一個台北日也算在同一列", () => {
    // 2026-09-15T23:30Z = 台北 09-16 07:30；2026-09-16T10:00Z = 台北 09-16 18:00
    const inRec = rec("in", "2026-09-15T23:30:00Z");
    const outRec = rec("out", "2026-09-16T10:00:00Z");
    const rows = buildDayRows([inRec, outRec], "2026-09-16", "2026-09-16", TZ);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      date: "2026-09-16",
      status: "complete",
      durationMin: 630,
    });
    expect(rows[0].in?.id).toBe(inRec.id);
    expect(rows[0].out?.id).toBe(outRec.id);
  });

  it("同日多筆：in 取最早、out 取最晚；輸入順序無關；其他 type 忽略", () => {
    const late = rec("in", "2026-09-16T01:05:00Z"); // 09:05
    const first = rec("in", "2026-09-16T01:00:00Z"); // 09:00
    const noon = rec("out", "2026-09-16T04:00:00Z"); // 12:00
    const last = rec("out", "2026-09-16T10:00:00+00:00"); // 18:00（+00:00 寫法）
    const breakRec = rec("break_in", "2026-09-16T04:30:00Z");
    const rows = buildDayRows([last, late, breakRec, noon, first], "2026-09-16", "2026-09-16", TZ);
    expect(rows).toHaveLength(1);
    expect(rows[0].in?.id).toBe(first.id);
    expect(rows[0].out?.id).toBe(last.id);
    expect(rows[0].status).toBe("complete");
    expect(rows[0].durationMin).toBe(540);
  });

  it("多日混合時依日期降冪，區間外但有紀錄的日子照列", () => {
    const rows = buildDayRows(
      [
        rec("in", "2026-09-14T01:00:00Z"),
        rec("out", "2026-09-14T10:00:00Z"),
        rec("in", "2026-09-18T01:00:00Z"), // 週五，在區間外
      ],
      "2026-09-14",
      "2026-09-16",
      TZ,
    );
    expect(rows.map((row) => row.date)).toEqual(["2026-09-18", "2026-09-16", "2026-09-15", "2026-09-14"]);
    expect(rows.map((row) => row.status)).toEqual(["missing_out", "none", "none", "complete"]);
    expect(rows[3].durationMin).toBe(540);
  });

  it("下班早於上班（順序異常）→ 仍算 complete 但時長 null", () => {
    const rows = buildDayRows(
      [rec("out", "2026-09-16T00:00:00Z"), rec("in", "2026-09-16T01:00:00Z")],
      "2026-09-16",
      "2026-09-16",
      TZ,
    );
    expect(rows[0].status).toBe("complete");
    expect(rows[0].durationMin).toBeNull();
  });

  it("區間無效（from > to 或格式錯）不補空列、無效 punch_at 略過；亂填年份不會補出無限列", () => {
    const r = rec("in", "2026-09-16T01:00:00Z");
    expect(buildDayRows([r, rec("in", "garbage")], "2026-09-18", "2026-09-14", TZ).map((row) => row.date)).toEqual([
      "2026-09-16",
    ]);
    expect(buildDayRows([r], "", "", TZ).map((row) => row.date)).toEqual(["2026-09-16"]);
    // "0202-09-17" 是 <input type=date> 打字打到一半會吐出的值
    const rows = buildDayRows([], "0202-09-17", "2026-09-17", TZ);
    expect(rows.length).toBeLessThanOrEqual(MAX_FILL_DAYS);
  });
});

/**
 * 行事曆（2026-10-12 教育訓練驗收：國定假日被列成「未打卡」）。日期是測試用的假設裁定：
 * 2026-10-09（五）國定假日、2026-09-19（六）補班、2026-09-16（三）公司自訂休息日。
 */
describe("isFillDay（要不要補「沒打卡」空列）", () => {
  it("沒有裁定＝週一～五；有裁定照裁定；國定假日一律要；無效日期一律不要", () => {
    expect(isFillDay("2026-10-09")).toBe(true); // 週五、沒裁定
    expect(isFillDay("2026-09-19")).toBe(false); // 週六、沒裁定
    // 國定假日一律補列（2026-10-12 業主要求：畫面標「國定假日」、不給補卡），落在週六也一樣
    expect(isFillDay("2026-10-09", "fixed_holiday")).toBe(true);
    expect(isFillDay("2026-10-10", "fixed_holiday")).toBe(true);
    expect(isFillDay("2026-09-16", "rest_day")).toBe(false);
    expect(isFillDay("2026-10-11", "rest_day")).toBe(false); // 週日的休息日照舊不列
    expect(isFillDay("2026-09-19", "workday")).toBe(true); // 補班
    expect(isFillDay("2026-09-20", "special")).toBe(false); // 看不懂的裁定 → 退回週一～五（週日）
    expect(isFillDay("not-a-date", "workday")).toBe(false);
    expect(isFillDay("2026-13-01")).toBe(false);
  });
});

describe("buildDayRows：依行事曆補空列", () => {
  it("休息日沒打卡不補列；補班的週六沒打卡要補列", () => {
    const dayTypeByDate = { "2026-09-16": "rest_day", "2026-09-19": "workday" };
    const rows = buildDayRows([], "2026-09-14", "2026-09-20", TZ, { dayTypeByDate });
    expect(rows.map((row) => row.date)).toEqual(["2026-09-19", "2026-09-18", "2026-09-17", "2026-09-15", "2026-09-14"]);
    expect(rows.every((row) => row.status === "none")).toBe(true);
  });

  it("國定假日沒打卡也補一列（含落在週六的）；一般週末休息日照舊不列", () => {
    const holiday = buildDayRows([], "2026-10-05", "2026-10-11", TZ, {
      dayTypeByDate: { "2026-10-09": "fixed_holiday", "2026-10-10": "fixed_holiday", "2026-10-11": "rest_day" },
    });
    expect(holiday.map((row) => [row.date, row.status])).toEqual([
      ["2026-10-10", "none"], // 週六的國定假日
      ["2026-10-09", "none"], // 週五的國定假日
      ["2026-10-08", "none"],
      ["2026-10-07", "none"],
      ["2026-10-06", "none"],
      ["2026-10-05", "none"],
    ]);
  });

  it("國定假日有打卡照列（不論是否上班日都照打卡狀態）", () => {
    // 2026-10-09T01:00Z = 台北 10/09（五）09:00
    const rows = buildDayRows([rec("in", "2026-10-09T01:00:00Z")], "2026-10-09", "2026-10-09", TZ, {
      dayTypeByDate: { "2026-10-09": "fixed_holiday" },
    });
    expect(rows.map((row) => [row.date, row.status])).toEqual([["2026-10-09", "missing_out"]]);
  });

  it("沒帶行事曆（或行事曆抓不到＝空表）→ 舊規則週一～五", () => {
    const withEmpty = buildDayRows([], "2026-10-05", "2026-10-11", TZ, { dayTypeByDate: {} });
    const without = buildDayRows([], "2026-10-05", "2026-10-11", TZ);
    expect(withEmpty).toEqual(without);
    expect(without.map((row) => row.date)).toEqual(["2026-10-09", "2026-10-08", "2026-10-07", "2026-10-06", "2026-10-05"]);
  });
});

describe("補卡連結帶卡別", () => {
  it("缺下班 → out；缺上班、整天沒打卡 → in", () => {
    expect(fixPunchTypeOf("missing_out")).toBe("out");
    expect(fixPunchTypeOf("missing_in")).toBe("in");
    expect(fixPunchTypeOf("none")).toBe("in");
  });

  it("連結帶 kind、date、type", () => {
    expect(fixPunchHref("2026-09-16", "out")).toBe("/ess/requests?kind=fix_punch&date=2026-09-16&type=out");
    expect(fixPunchHref("2026-09-16", "in")).toBe("/ess/requests?kind=fix_punch&date=2026-09-16&type=in");
    const params = new URL(fixPunchHref("2026-09-16", "out"), "https://example.test").searchParams;
    expect([params.get("kind"), params.get("date"), params.get("type")]).toEqual(["fix_punch", "2026-09-16", "out"]);
  });
});
