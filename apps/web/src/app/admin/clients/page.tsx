"use client";
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Card, Empty, ErrorText, Pill, inputCls } from "@/components/admin-ui";
import { listClients, deleteClient, PAYMENT_METHOD_LABELS, type Client, type ClientCategory } from "@/lib/projects-ext-api";
import { OPTION_INACTIVE_MARK, optionLabel, useOptionList } from "@/lib/option-lists-api";
import { useRosterRoles } from "@/components/roster-detail";
import { CLIENT_EXCEL_COLUMNS, clientCellText, sortClientsByRegion } from "@/lib/roster-columns";
import { NEW_ROSTER_ID, rosterDetailHref } from "@/lib/roster-forms";
import { buttonClass } from "@/components/ess-ui";
import {
  ROSTER_BODY_ROW, ROSTER_HEAD_ROW, ROSTER_TABLE, ROSTER_TABLE_WRAP, ROSTER_TD_ACTIONS, ROSTER_TD_FROZEN, ROSTER_TD_HOVER, ROSTER_TH, ROSTER_TH_FROZEN,
} from "@/lib/roster-table";

/** 區域欄固定 5rem（含左內距）；簡稱欄黏在它右邊（left-20＝5rem）。 */
const REGION_COL = "left-0 w-20 min-w-20 max-w-20 pl-2";
const SHORT_COL = "left-20 whitespace-nowrap border-r border-r-gray-200";
/** 凍結兩欄之後的第一欄（目前是「編號」）。 */
const FIRST_SCROLL_KEY = CLIENT_EXCEL_COLUMNS.find((c) => c.key !== "region" && c.key !== "shortName")?.key;

/**
 * 客戶名冊（模組五）。建案表單的客戶下拉、專案申請單列印都吃這裡的資料。
 * 統編非必填（自然人業主或尚未取得統編的案子可以先建檔），比照廠商名冊
 * 的軟刪除慣例——刪除只是從列表收起來，往來紀錄不會消失。
 *
 * 關係企業（2026-10-11）：表單可勾「關係企業（集團內姊妹公司）」，列表名稱旁顯示徽章。集團總覽的集團合計
 * 會剔除這類客戶的專案收入（各公司自己的數字照常包含）。這個標記會改變老闆看的集團數字，所以只有
 * HR／平台管理員能設定（API 對會計回 403 affiliate_hr_only）；會計看得到但勾選框是停用的，
 * 存檔時也只在旗標有變動才送出，免得會計改別的欄位被擋。
 *
 * 分類（2026-10-10）：選項不再寫死，吃「設定 → 選項清單 → 客戶分類」（`useOptionList("client_category")`），
 * 管理員可自行新增。篩選下拉列出全部項目（含已停用的——舊客戶可能還用著）；表單下拉只列啟用的項目，
 * 外加這位客戶目前已選的停用項（標「（已停用）」，開舊客戶編輯時下拉不會悄悄換成「未分類」）。
 *
 * 欄位對齊 Excel（2026-10-27）：列表欄位與順序＝業主「客供商基本資料／客戶資料」（lib/roster-columns.ts），
 * 可橫向捲動、第一欄（簡稱）凍結。Excel 沒有的欄位（分類、發票聯式、結帳日、付款日、關係企業）只在編輯表單的「其他」區；
 * 分類仍可在上方篩選。刪除限 HR（API requireHrAdmin），會計看不到刪除鈕。
 *
 * 內頁編輯（2026-10-27 業主）：「編輯」、簡稱、公司名稱都連到客戶內頁 /admin/clients/[id]，「新增客戶」連到
 * /admin/clients/new（app/admin/clients/[id]/page.tsx，表單欄位與權限都在那裡）；列表本身不再有表單。
 * 表頭列往下捲時釘在上方，左側區域＋簡稱兩欄凍結（lib/roster-table.ts）。
 */
export default function ClientsPage() {
  const categories = useOptionList("client_category");
  /** 分類 code → 名稱；清單載入中先顯示「…」，免得閃過原始代碼。 */
  const categoryText = (code: string) => (categories.loading ? "…" : optionLabel(categories.items, code));
  const [clients, setClients] = useState<Client[]>([]);
  const [q, setQ] = useState("");
  const [categoryFilter, setCategoryFilter] = useState<ClientCategory | "">("");
  const [error, setError] = useState<string | null>(null);
  // 刪除只限 HR／平台管理員（API requireHrAdmin）；取不到角色就當不能。
  const { isHr: canDelete } = useRosterRoles();

  const load = useCallback(async () => {
    try {
      const r = await listClients(q.trim() || undefined);
      setClients(r.clients);
    } catch (err) {
      setError(err instanceof Error ? err.message : "載入失敗");
    }
  }, [q]);
  useEffect(() => {
    const t = setTimeout(() => void load(), 200);
    return () => clearTimeout(t);
  }, [load]);

  const [regionSort, setRegionSort] = useState<"asc" | "desc" | null>(null);
  const filtered = categoryFilter ? clients.filter((c) => c.category === categoryFilter) : clients;
  const shown = regionSort ? sortClientsByRegion(filtered, regionSort) : filtered;

  async function remove(c: Client) {
    if (!confirm(`刪除客戶「${c.name}」？（軟刪除，往來紀錄仍保留）`)) return;
    try {
      await deleteClient(c.id);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "刪除失敗");
    }
  }

  /**
   * 左側凍結兩欄：區域（固定 5rem，過長以…截斷，不會溢到簡稱欄）＋簡稱（接在區域右邊，右緣加分隔線）。
   * 沒填簡稱時以灰字帶出公司名稱，捲到右邊仍認得是哪一家。
   */
  const headClass = (key: string) =>
    key === "region" ? `${ROSTER_TH_FROZEN} left-0 ${REGION_COL}` : key === "shortName" ? `${ROSTER_TH_FROZEN} ${SHORT_COL}` : `${ROSTER_TH} ${afterFrozen(key)}`;
  /** 凍結欄右邊第一欄多一點左內距，不要貼著分隔線。 */
  const afterFrozen = (key: string) => (key === FIRST_SCROLL_KEY ? "pl-3" : "");

  return (
    <>
      {error && <div className="mb-3"><ErrorText>{error}</ErrorText></div>}

      <Card>
        <div className="mb-3 flex flex-wrap items-center gap-3">
          <input className={`${inputCls} max-w-xs`} value={q} onChange={(e) => setQ(e.target.value)} placeholder="搜尋名稱 / 簡稱 / 統編 / 承辦 / 電話" />
          <select
            className="rounded-lg border border-gray-200 px-2 py-1.5 text-sm"
            value={categoryFilter}
            onChange={(e) => setCategoryFilter(e.target.value as ClientCategory | "")}
            aria-label="客戶分類篩選"
          >
            <option value="">全部分類</option>
            {categories.items.map((item) => (
              <option key={item.code} value={item.code}>{item.label}{item.isActive ? "" : OPTION_INACTIVE_MARK}</option>
            ))}
          </select>
          {categories.canManage && (
            <Link href="/admin/option-lists" className="text-xs text-gray-500 underline hover:text-gray-700">管理分類</Link>
          )}
          {categories.error && (
            <button type="button" onClick={categories.reload} className="text-xs text-red-600 underline">分類載入失敗，點此重試</button>
          )}
          <Link href={rosterDetailHref("clients", NEW_ROSTER_ID)} className={`${buttonClass("primary")} md:min-h-10`} style={{ backgroundColor: "var(--brand)" }}>新增客戶</Link>
          <span className="text-sm text-gray-500">{shown.length} 家{categoryFilter ? `（共 ${clients.length} 家）` : ""}</span>
        </div>
        {shown.length === 0 ? (
          <Empty>{q || categoryFilter ? "沒有符合的客戶" : "尚無客戶，請先新增。"}</Empty>
        ) : (
          <div className={ROSTER_TABLE_WRAP}>
            <table className={ROSTER_TABLE}>
              <thead>
                <tr className={ROSTER_HEAD_ROW}>
                  {CLIENT_EXCEL_COLUMNS.map((col) => (
                    <th
                      key={col.key}
                      scope="col"
                      className={headClass(col.key)}
                      aria-sort={col.key === "region" && regionSort ? (regionSort === "asc" ? "ascending" : "descending") : undefined}
                    >
                      {col.key === "region" ? (
                        <button
                          type="button"
                          className="inline-flex items-center gap-1 hover:text-gray-900"
                          onClick={() => setRegionSort((s) => (s === null ? "asc" : s === "asc" ? "desc" : null))}
                          title="依區域排序（再按一次反向，第三次取消）"
                        >
                          {col.header}
                          <span aria-hidden className={regionSort ? "text-[var(--brand)]" : "text-gray-400"}>{regionSort === "asc" ? "▲" : regionSort === "desc" ? "▼" : "↕"}</span>
                        </button>
                      ) : (
                        col.header
                      )}
                    </th>
                  ))}
                  <th scope="col" className={`${ROSTER_TH_FROZEN} right-0 border-l border-l-gray-200 pl-3 pr-2`}><span className="sr-only">操作</span></th>
                </tr>
              </thead>
              <tbody>
                {shown.map((c) => {
                  const href = rosterDetailHref("clients", c.id);
                  return (
                    <tr key={c.id} className={ROSTER_BODY_ROW}>
                      {CLIENT_EXCEL_COLUMNS.map((col) => {
                        const value = clientCellText(c, col.key, PAYMENT_METHOD_LABELS);
                        if (col.key === "region") {
                          return (
                            <td key={col.key} className={`${ROSTER_TD_FROZEN} ${REGION_COL} py-2 pr-3 text-gray-600`} title={value || undefined}>
                              <div className="w-[3.75rem] truncate">{value || "—"}</div>
                            </td>
                          );
                        }
                        if (col.key === "shortName") {
                          return (
                            <th key={col.key} scope="row" className={`${ROSTER_TD_FROZEN} ${SHORT_COL} py-2 pr-3 text-left font-medium text-gray-900`}>
                              <Link href={href} className="hover:text-[var(--brand)] hover:underline">
                                {value || <span className="font-normal text-gray-400" title="未填簡稱，顯示公司名稱">{c.name}</span>}
                              </Link>
                            </th>
                          );
                        }
                        if (col.key === "name") {
                          return (
                            <td key={col.key} className={`${ROSTER_TD_HOVER} min-w-[10rem] py-2 pr-3 text-gray-900`}>
                              <Link href={href} className="hover:text-[var(--brand)] hover:underline">{value}</Link>
                              {c.isAffiliate === true && <Pill tone="blue" className="ml-1.5 align-middle">關係企業</Pill>}
                              {c.category && (
                                <span className="ml-1.5 rounded-full bg-gray-100 px-2 py-0.5 align-middle text-xs text-gray-600">{categoryText(c.category)}</span>
                              )}
                            </td>
                          );
                        }
                        return (
                          <td
                            key={col.key}
                            className={`${ROSTER_TD_HOVER} ${afterFrozen(col.key)} py-2 pr-3 text-gray-600 ${col.multiline ? "min-w-[9rem] max-w-[18rem] whitespace-pre-line break-words" : "whitespace-nowrap"}`}
                          >
                            {value || "—"}
                          </td>
                        );
                      })}
                      <td className={ROSTER_TD_ACTIONS}>
                        <Link href={href} className="mr-3 text-xs text-gray-600 hover:underline">編輯</Link>
                        {canDelete && (
                          <button type="button" onClick={() => void remove(c)} className="text-xs text-gray-400 hover:text-red-600">刪除</button>
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
