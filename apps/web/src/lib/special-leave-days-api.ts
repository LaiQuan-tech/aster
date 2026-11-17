/**
 * 特殊假日（颱風假等，2026-11-17）client＋型別。後端：apps/api/src/routes/special-leave-days.ts。
 * 型別是手抄的：web 與 api 是各自的 build 邊界。
 */
import { apiFetch } from "./api-client";

export type SpecialScope = "all" | "departments" | "employees";

export const SPECIAL_SCOPE_LABEL: Record<SpecialScope, string> = {
  all: "全公司",
  departments: "指定部門",
  employees: "指定員工",
};

/** 名稱預設選項（可自訂）。 */
export const SPECIAL_NAME_PRESETS = ["颱風假", "停班停課", "防疫假", "天災假", "公司休假"] as const;

export interface SpecialLeaveDay {
  id: string;
  startDate: string;
  endDate: string;
  days: number;
  name: string;
  paid: boolean;
  /** 「颱風假（無薪）」。 */
  label: string;
  scope: SpecialScope;
  departmentIds: string[];
  departmentNames: string[];
  employeeIds: string[];
  employeeNames: string[];
  note: string | null;
  /** 區間內在職、且在範圍內的人數。 */
  affectedCount: number;
  createdByName: string | null;
  createdAt: string | null;
  updatedAt: string | null;
}

export interface SpecialRecalc {
  period: string;
  status: "done" | "closed" | "failed";
  rebuilt?: number;
  /** 已送出（含主管已審）未套用的月表數。 */
  submitted?: number;
  /** 已核准／鎖定未套用的月表數。 */
  approved?: number;
  /** 該月未定案的薪資單數。 */
  draftPayslips?: number;
  error?: string;
}

export interface SpecialLeaveDayBody {
  startDate: string;
  endDate?: string;
  name: string;
  paid: boolean;
  scope: SpecialScope;
  departmentIds?: string[];
  employeeIds?: string[];
  note?: string | null;
}

export function listSpecialLeaveDays(year: number) {
  return apiFetch<{ year: number; days: SpecialLeaveDay[] }>(`/special-leave-days?year=${year}`);
}

export function createSpecialLeaveDay(body: SpecialLeaveDayBody) {
  return apiFetch<{ day: SpecialLeaveDay; recalc: SpecialRecalc[] }>("/special-leave-days", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export function updateSpecialLeaveDay(id: string, body: Partial<SpecialLeaveDayBody>) {
  return apiFetch<{ day: SpecialLeaveDay; recalc: SpecialRecalc[] }>(`/special-leave-days/${id}`, {
    method: "PATCH",
    body: JSON.stringify(body),
  });
}

export function deleteSpecialLeaveDay(id: string) {
  return apiFetch<{ deleted: number; recalc: SpecialRecalc[] }>(`/special-leave-days/${id}`, { method: "DELETE" });
}

export interface MySpecialDay {
  date: string;
  name: string;
  paid: boolean;
  label: string;
}

/** 員工自己命中的特殊假日（只回工作日）。 */
export function getMySpecialDays(from: string, to: string) {
  return apiFetch<{ from: string; to: string; days: MySpecialDay[] }>(
    `/special-leave-days/mine?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
  );
}

/** 重算結果 → 給 HR 的一句話（純函式）。 */
export function recalcSummary(recalc: readonly SpecialRecalc[] | null | undefined): { text: string; warn: boolean } {
  const list = recalc ?? [];
  if (list.length === 0) return { text: "已儲存", warn: false };
  const parts: string[] = [];
  let warn = false;
  for (const r of list) {
    const ym = r.period.replace("-", "/");
    if (r.status === "closed") {
      parts.push(`${ym} 已結算，不追溯`);
      warn = true;
    } else if (r.status === "failed") {
      parts.push(`${ym} 自動重算失敗，請到出勤統計表按「重算」`);
      warn = true;
    } else {
      const submitted = r.submitted ?? 0;
      const approved = r.approved ?? 0;
      const slips = r.draftPayslips ?? 0;
      let text = `${ym} 已重算草稿月表 ${r.rebuilt ?? 0} 張`;
      if (submitted > 0 || approved > 0) {
        text += `；已送出 ${submitted} 張、已核准 ${approved} 張月表未套用，需退回後重算`;
        warn = true;
      }
      if (slips > 0) {
        text += `；該月已有未定案薪資單（${slips} 張），請重跑薪資`;
        warn = true;
      }
      parts.push(text);
    }
  }
  return { text: `已儲存。${parts.join("。")}`, warn };
}

/** 範圍說明：「全公司」「業務部、工程部」「王小明等 3 人」（純函式）。 */
export function scopeText(day: Pick<SpecialLeaveDay, "scope" | "departmentNames" | "employeeNames">): string {
  if (day.scope === "departments") return day.departmentNames.join("、") || "指定部門";
  if (day.scope === "employees") {
    const names = day.employeeNames;
    return names.length > 3 ? `${names.slice(0, 3).join("、")} 等 ${names.length} 人` : names.join("、") || "指定員工";
  }
  return "全公司";
}

/** 日期區間顯示：單日「10/13（一）」、區間「10/13–10/14」（純函式）。 */
export function rangeText(startDate: string, endDate: string): string {
  const WEEKDAY = ["日", "一", "二", "三", "四", "五", "六"];
  const md = (d: string) => `${Number(d.slice(5, 7))}/${Number(d.slice(8, 10))}`;
  if (startDate === endDate) {
    const wd = new Date(`${startDate}T00:00:00Z`).getUTCDay();
    return `${md(startDate)}（${WEEKDAY[wd]}）`;
  }
  return `${md(startDate)}–${md(endDate)}`;
}
