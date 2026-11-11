import { formatMoney } from "./money";
import { engineerDisciplinesOf, type ApplicationData, type ApplicationVersionList, type ApplicationVersionMeta, type ProjectDetail } from "./projects-ext-api";

/**
 * 專案申請單版本（2026-11-10）——純函式（畫面文字、快照轉申請單元件的 props）。
 *   合約金額（銷售金額未稅）改了 → 後端在同一流程建下一版（services/application-versions.ts）；
 *   目前版＝即時資料，舊版是快照（唯讀、可列印、不可還原）。
 */

/** ISO 時間 → 台北日期 'YYYY-MM-DD'。 */
export function versionDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso.slice(0, 10);
  return d.toLocaleDateString("sv-SE", { timeZone: "Asia/Taipei" });
}

/** 版本號文字：「第 3 版」。 */
export function versionNoLabel(no: number): string {
  return `第 ${no} 版`;
}

/** 這一版是怎麼來的（下拉選項／橫幅用）。 */
export function versionReason(v: Pick<ApplicationVersionMeta, "trigger" | "amountBefore" | "amountAfter" | "note">): string {
  const money = (n: number | null) => formatMoney(n);
  switch (v.trigger) {
    case "contract_amount_changed":
      return `合約金額 ${money(v.amountBefore)}→${money(v.amountAfter)}`;
    case "initial":
      return `初版（合約金額 ${money(v.amountAfter)}）`;
    case "manual":
      return v.note ? `手動另存：${v.note}` : "手動另存";
  }
}

/**
 * 版本下拉選項：最新那一版標「（目前）」＝即時資料；其他是「第 2 版 2026-03-01 合約金額 1,428,571→1,600,000」。
 * 還沒有任何版本時只有一個「第 1 版（目前）」（value 0＝即時資料）。
 */
export function versionOptions(versions: ApplicationVersionMeta[]): Array<{ value: number; label: string; current: boolean }> {
  if (versions.length === 0) return [{ value: 0, label: `${versionNoLabel(1)}（目前）`, current: true }];
  const sorted = [...versions].sort((a, b) => b.versionNo - a.versionNo);
  return sorted.map((v, i) =>
    i === 0
      ? { value: v.versionNo, label: `${versionNoLabel(v.versionNo)}（目前）`, current: true }
      : { value: v.versionNo, label: `${versionNoLabel(v.versionNo)} ${versionDate(v.createdAt)} ${versionReason(v)}`, current: false },
  );
}

/** 目前版號（沒有任何版本＝1：申請單本身就是第 1 版）。 */
export function currentVersionNo(versions: ApplicationVersionMeta[]): number {
  return versions.reduce((max, v) => Math.max(max, v.versionNo), 0) || 1;
}

/** 檢視舊版時的黃色橫幅文字。 */
export function oldVersionBanner(v: Pick<ApplicationVersionMeta, "versionNo" | "createdAt">): string {
  return `正在檢視${versionNoLabel(v.versionNo)}（${versionDate(v.createdAt)} 建立），非目前內容`;
}

/**
 * 快照（＝ GET /projects/:id/application 的 application 段）→ ApplicationSheet 的資料 props。
 * 與列印頁 ApplicationDocument 相同：project 段不含 client，補回去就是明細頁同一份資料形狀。
 */
export function snapshotSheetProps(snapshot: ApplicationData) {
  const project = { ...snapshot.project, client: snapshot.client, openedOn: snapshot.openedOn } as ProjectDetail;
  return {
    project,
    money: snapshot.money,
    billings: snapshot.billings ?? [],
    subcontracts: snapshot.subcontracts ?? [],
    latestDocument: snapshot.latestDocument ?? null,
    disciplines: engineerDisciplinesOf(snapshot.settings?.disciplines),
    clients: snapshot.client ? [snapshot.client] : [],
  };
}

/**
 * 列印頁要印哪一份：?version=N 是舊版（版本清單裡有、且不是目前版）→ 快照；
 * 沒帶、帶的是目前版號、版本功能未套用 → 即時資料（與申請單目前畫面一致）。
 * 清單裡找不到的版號照樣走快照（讓 API 回 404 顯示錯誤，不默默印成目前內容）。
 */
export function printSourceFor(
  requested: number | null,
  list: Pick<ApplicationVersionList, "versions"> | null,
): { kind: "live" } | { kind: "snapshot"; versionNo: number } {
  if (requested === null || !list) return { kind: "live" };
  if (list.versions.length === 0) return requested === 1 ? { kind: "live" } : { kind: "snapshot", versionNo: requested };
  if (requested === currentVersionNo(list.versions)) return { kind: "live" };
  return { kind: "snapshot", versionNo: requested };
}
