/**
 * 未核准加班報表（2026-11 加班事前核准制）— client 與純函式。
 *
 * 合約（固定，欄位名不可改）：GET /reports/unapproved-overtime?period=YYYY-MM →
 *   { period, rows: [{ employeeId, employeeName, employeeNo, days: [{ workDate, dayType, minutes }], totalMinutes }] }
 * 權限同其他 HR 報表（API requireHrAdmin：HR、平台管理員）。
 *
 * API 尚未部署／欄位缺漏時：normalize 一律補預設值，不丟例外；404 由頁面顯示「伺服器端尚未上線」。
 */
import { apiFetch } from "./api-client";
import { dayTypeLabel, fmtMinutesHm } from "./overtime-approval";

export interface UnapprovedOvertimeDay {
  workDate: string;
  dayType: string;
  minutes: number;
}

export interface UnapprovedOvertimeRow {
  employeeId: string;
  employeeName: string;
  employeeNo: string;
  days: UnapprovedOvertimeDay[];
  totalMinutes: number;
}

export interface UnapprovedOvertimeReport {
  period: string;
  rows: UnapprovedOvertimeRow[];
}

function str(value: unknown): string {
  return typeof value === "string" ? value : typeof value === "number" ? String(value) : "";
}

function num(value: unknown): number {
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(n) ? n : 0;
}

/** 把 API 回應整理成固定形狀：rows 不是陣列 → []；days 依日期排序；totalMinutes 缺漏 → days 加總。 */
export function normalizeUnapprovedOvertime(raw: unknown, period: string): UnapprovedOvertimeReport {
  const body = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const rawRows = Array.isArray(body.rows) ? body.rows : [];
  const rows: UnapprovedOvertimeRow[] = [];
  for (const item of rawRows) {
    if (!item || typeof item !== "object") continue;
    const r = item as Record<string, unknown>;
    const days = (Array.isArray(r.days) ? r.days : [])
      .filter((d): d is Record<string, unknown> => !!d && typeof d === "object")
      .map((d) => ({ workDate: str(d.workDate), dayType: str(d.dayType), minutes: num(d.minutes) }))
      .sort((a, b) => a.workDate.localeCompare(b.workDate));
    const total = r.totalMinutes === undefined || r.totalMinutes === null
      ? days.reduce((sum, d) => sum + d.minutes, 0)
      : num(r.totalMinutes);
    rows.push({
      employeeId: str(r.employeeId),
      employeeName: str(r.employeeName),
      employeeNo: str(r.employeeNo),
      days,
      totalMinutes: total,
    });
  }
  return { period: str(body.period) || period, rows };
}

export async function getUnapprovedOvertimeReport(period: string): Promise<UnapprovedOvertimeReport> {
  const raw = await apiFetch<unknown>(`/reports/unapproved-overtime?period=${encodeURIComponent(period)}`);
  return normalizeUnapprovedOvertime(raw, period);
}

/** API 回 404（端點還沒部署）。 */
export function isReportNotDeployed(err: unknown): boolean {
  return err instanceof Error && (err as Error & { status?: number }).status === 404;
}

function csvCell(value: string): string {
  return /[",\n\r]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/**
 * 匯出 CSV（UTF-8 BOM，Excel 直接開；同後台其他頁的前端匯出做法）：每位員工每一天一列，
 * 欄位：員工編號／姓名／日期／日別／時數（時:分）／該員未核准天數／該員總時數（時:分）。
 */
export function unapprovedOvertimeCsv(report: UnapprovedOvertimeReport): string {
  const header = ["員工編號", "姓名", "日期", "日別", "時數", "未核准天數", "總時數"];
  const lines = [header.join(",")];
  for (const row of report.rows) {
    const common = [row.employeeNo, row.employeeName];
    const tail = [String(row.days.length), fmtMinutesHm(row.totalMinutes)];
    if (row.days.length === 0) {
      lines.push([...common, "", "", "", ...tail].map(csvCell).join(","));
      continue;
    }
    for (const day of row.days) {
      lines.push([...common, day.workDate, dayTypeLabel(day.dayType), fmtMinutesHm(day.minutes), ...tail].map(csvCell).join(","));
    }
  }
  return `﻿${lines.join("\r\n")}`;
}
