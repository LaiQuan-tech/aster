"use client";
import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { Card, Empty, ErrorText, Pill, inputCls, useToast } from "@/components/admin-ui";
import { buttonClass } from "@/components/ess-ui";
import { useRosterRoles } from "@/components/roster-detail";
import { buildRemittanceText, copyText } from "@/lib/remittance";
import { listVendors, deleteVendor, type Vendor, type VendorRosterKind } from "@/lib/company-api";
import {
  VENDOR_EXCEL_COLUMNS, VENDOR_ROSTER_KINDS, VENDOR_ROSTER_KIND_LABELS,
  countVendorsByKind, filterVendorsByKind, vendorCellText, vendorRosterKind,
} from "@/lib/roster-columns";
import { NEW_ROSTER_ID, rosterDetailHref } from "@/lib/roster-forms";
import {
  ROSTER_BODY_ROW, ROSTER_HEAD_ROW, ROSTER_TABLE, ROSTER_TABLE_WRAP, ROSTER_TD_ACTIONS, ROSTER_TD_FROZEN, ROSTER_TD_HOVER, ROSTER_TH, ROSTER_TH_FROZEN,
} from "@/lib/roster-table";

/**
 * 廠商名冊 · 名片建檔。
 * 名片流程：選影像 → API 存檔並送 Gemini 抽欄位 → 帶進表單 → 人確認後才「新增廠商」。
 * 辨識只給建議值，永遠不會自己建檔；沒設 AI 金鑰時名片按鈕會說明，手動建檔照常。
 *
 * M15（2026-09-23）：每列一個「複製帳號」——戶名／銀行（代號）／帳號三行，貼進網銀
 * 轉帳頁剛好對應欄位。戶名優先用 accountHolder（帳戶開戶名），沒填才退回廠商名稱；
 * 文字組裝與剪貼簿三段式退路共用 lib/remittance.ts（與放款單明細頁同一份）。
 *
 * 關係企業（2026-10-11）：表單可勾「關係企業（集團內姊妹公司）」，列表名稱旁顯示徽章。集團總覽的集團合計
 * 會剔除付給這類廠商的放款（各公司自己的數字照常包含）。這個標記會改變老闆看的集團數字，所以只有
 * HR／平台管理員能設定（API 對其他角色回 403 affiliate_hr_only）；其他人看得到但勾選框是停用的，
 * 存檔時也只在旗標有變動才送出，免得改別的欄位被擋。
 *
 * 欄位對齊 Excel（2026-10-27）：列表欄位與順序＝業主的「客供商基本資料」（lib/roster-columns.ts），
 * 可橫向捲動、第一欄（簡稱）凍結；三個工作表（供應商／技師／送審相關單位）用上方頁籤篩選。
 * Excel 沒有的欄位（職稱、銀行帳戶、關係企業、名片）只在編輯表單的「其他」區。
 *
 * 權限（2026-10-27 業主決定）：新增／修改／名片辨識限會計與 HR（API requireFinance），刪除限 HR；
 * 沒權限的人看不到「拍名片建檔／手動新增／編輯／刪除」，只能讀。收款帳戶（銀行四欄、複製帳號）也只給會計與 HR
 * （API 對其他角色回 null）；銀行欄位只在編輯表單，表單本身就只開給會計與 HR。
 *
 * 內頁編輯（2026-10-27 業主）：「編輯」、簡稱、公司名稱都連到廠商內頁 /admin/vendors/[id]；「拍名片建檔」
 * 「手動新增」連到 /admin/vendors/new（帶目前頁籤的 ?kind=）。名片辨識、表單欄位與權限都在
 * app/admin/vendors/[id]/page.tsx；列表本身不再有表單。表頭列往下捲時釘在上方（lib/roster-table.ts）。
 */
/** 第一欄（簡稱）凍結：沒填簡稱時以灰字帶出公司名稱，捲到右邊仍認得是哪一家；右緣分隔線。 */
const FIRST_COL = "left-0 whitespace-nowrap border-r border-r-gray-200 pl-2";

export default function VendorsPage() {
  const toast = useToast();
  const [vendors, setVendors] = useState<Vendor[]>([]);
  const [q, setQ] = useState("");
  const [kind, setKind] = useState<VendorRosterKind | "all">("all");
  const [error, setError] = useState<string | null>(null);
  // 新增／修改：會計與 HR（API requireFinance）；刪除：HR。取不到角色就當不能。
  const { isHr: canDelete, isAdmin: canEdit } = useRosterRoles();
  /** 收款帳戶（複製帳號）只給會計與 HR——與新增／修改同一組角色（API 對其他人回 null）。 */
  const canSeeBank = canEdit;

  const load = useCallback(async () => {
    try {
      const r = await listVendors(q.trim() || undefined);
      setVendors(r.vendors);
    } catch (err) {
      setError(err instanceof Error ? err.message : "載入失敗");
    }
  }, [q]);
  useEffect(() => {
    const t = setTimeout(() => void load(), 200);
    return () => clearTimeout(t);
  }, [load]);

  /** M15：把該廠商的匯款資訊放進剪貼簿。沒有帳號就不給按，免得貼出三行破折號。 */
  async function copyRemittance(v: Vendor) {
    const text = buildRemittanceText({
      payeeName: v.accountHolder ?? v.name,
      payeeBankName: v.bankName,
      payeeBankCode: v.bankCode,
      payeeBankAccount: v.bankAccount,
    });
    const ok = await copyText(text);
    if (ok) toast.show("已複製匯款資訊", "success");
  }

  async function remove(v: Vendor) {
    if (!confirm(`刪除廠商「${v.name}」？（軟刪除，紀錄仍保留）`)) return;
    try { await deleteVendor(v.id); await load(); } catch (err) { setError(err instanceof Error ? err.message : "刪除失敗"); }
  }

  const counts = useMemo(() => countVendorsByKind(vendors), [vendors]);
  const shown = useMemo(() => filterVendorsByKind(vendors, kind), [vendors, kind]);

  const newHref = `${rosterDetailHref("vendors", NEW_ROSTER_ID)}${kind === "all" ? "" : `?kind=${kind}`}`;

  return (
    <>
      {error && <div className="mb-3"><ErrorText>{error}</ErrorText></div>}

      <Card>
        <div className="mb-3 flex flex-wrap items-center gap-2" role="tablist" aria-label="名冊類別">
          {(["all", ...VENDOR_ROSTER_KINDS] as const).map((k) => (
            <button
              key={k}
              type="button"
              role="tab"
              aria-selected={kind === k}
              onClick={() => setKind(k)}
              className={`rounded-full border px-3 py-1 text-sm ${kind === k ? "border-gray-900 bg-gray-900 text-white" : "border-gray-300 text-gray-700 hover:bg-gray-50"}`}
            >
              {k === "all" ? "全部" : VENDOR_ROSTER_KIND_LABELS[k]}
              <span className={`ml-1 text-xs ${kind === k ? "text-gray-200" : "text-gray-400"}`}>{counts[k]}</span>
            </button>
          ))}
        </div>
        <div className="mb-3 flex flex-wrap items-center gap-3">
          <input className={`${inputCls} max-w-xs`} value={q} onChange={(e) => setQ(e.target.value)} placeholder="搜尋名稱 / 簡稱 / 窗口 / 統編 / 電話 / 類別 / 細目" />
          {canEdit && (
            <>
              <Link href={newHref} className="rounded-md border border-gray-300 px-3 py-2 text-sm text-gray-700 hover:bg-gray-50" title="到新增頁，右側「名片影像」拍照或上傳後自動帶入欄位">
                📷 拍名片建檔
              </Link>
              <Link href={newHref} className={`${buttonClass("primary")} md:min-h-10`} style={{ backgroundColor: "var(--brand)" }}>手動新增</Link>
            </>
          )}
          <span className="text-sm text-gray-500">{shown.length} 家{kind !== "all" ? `（共 ${vendors.length} 家）` : ""}</span>
        </div>
        {shown.length === 0 ? (
          <Empty>{q || kind !== "all" ? "沒有符合的廠商" : canEdit ? "尚無廠商。拍張名片或手動新增。" : "尚無廠商。"}</Empty>
        ) : (
          <div className={ROSTER_TABLE_WRAP}>
            <table className={ROSTER_TABLE}>
              <thead>
                <tr className={ROSTER_HEAD_ROW}>
                  {VENDOR_EXCEL_COLUMNS.map((col, i) => (
                    <th key={col.key} scope="col" className={i === 0 ? `${ROSTER_TH_FROZEN} ${FIRST_COL}` : `${ROSTER_TH} ${i === 1 ? "pl-3" : ""}`}>{col.header}</th>
                  ))}
                  <th scope="col" className={`${ROSTER_TH_FROZEN} right-0 border-l border-l-gray-200 pl-3 pr-2`}><span className="sr-only">操作</span></th>
                </tr>
              </thead>
              <tbody>
                {shown.map((v) => {
                  const href = rosterDetailHref("vendors", v.id);
                  return (
                    <tr key={v.id} className={ROSTER_BODY_ROW}>
                      {VENDOR_EXCEL_COLUMNS.map((col, i) => {
                        const value = vendorCellText(v, col.key);
                        if (i === 0) {
                          return (
                            <th key={col.key} scope="row" className={`${ROSTER_TD_FROZEN} ${FIRST_COL} py-2 pr-3 text-left font-medium text-gray-900`}>
                              <Link href={href} className="hover:text-[var(--brand)] hover:underline">
                                {value || <span className="font-normal text-gray-400" title="未填簡稱，顯示公司名稱">{v.name}</span>}
                              </Link>
                            </th>
                          );
                        }
                        if (col.key === "name") {
                          return (
                            <td key={col.key} className={`${ROSTER_TD_HOVER} min-w-[10rem] py-2 pr-3 text-gray-900`}>
                              <Link href={href} className="hover:text-[var(--brand)] hover:underline">{value}</Link>
                              {v.hasCard && <span className="ml-1 text-xs text-gray-400" title="有名片影像">🪪</span>}
                              {v.isAffiliate === true && <Pill tone="blue" className="ml-1.5 align-middle">關係企業</Pill>}
                              {kind === "all" && vendorRosterKind(v) !== "supplier" && (
                                <Pill tone="gray" className="ml-1.5 align-middle">{VENDOR_ROSTER_KIND_LABELS[vendorRosterKind(v)]}</Pill>
                              )}
                            </td>
                          );
                        }
                        if (col.key === "taxId") {
                          return (
                            <td key={col.key} className={`${ROSTER_TD_HOVER} whitespace-nowrap py-2 pr-3 text-gray-600`}>
                              {value || "—"}
                              {v.taxIdValid === false && <span className="ml-1 text-xs text-amber-700" title="統一編號檢查碼不符">⚠</span>}
                            </td>
                          );
                        }
                        return (
                          <td
                            key={col.key}
                            className={`${ROSTER_TD_HOVER} ${i === 1 ? "pl-3" : ""} py-2 pr-3 text-gray-600 ${col.multiline ? "min-w-[9rem] max-w-[18rem] whitespace-pre-line break-words" : "whitespace-nowrap"}`}
                          >
                            {value || "—"}
                          </td>
                        );
                      })}
                      <td className={ROSTER_TD_ACTIONS}>
                        {canSeeBank && (
                          <button
                            type="button"
                            onClick={() => void copyRemittance(v)}
                            disabled={!v.bankAccount}
                            title={v.bankAccount ? "複製戶名／銀行／帳號" : "這家廠商還沒填帳號"}
                            className="mr-3 text-xs text-gray-600 hover:underline disabled:cursor-not-allowed disabled:text-gray-300 disabled:no-underline"
                          >
                            複製帳號
                          </button>
                        )}
                        {canEdit && (
                          <Link href={href} className="mr-3 text-xs text-gray-600 hover:underline">編輯</Link>
                        )}
                        {canDelete && (
                          <button type="button" onClick={() => void remove(v)} className="text-xs text-gray-400 hover:text-red-600">刪除</button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>

    </>
  );
}
