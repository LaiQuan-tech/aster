"use client";
import { useCallback, useEffect, useState } from "react";
import { Card, Empty, ErrorText, PrimaryButton, inputCls } from "@/components/admin-ui";
import type { ApiError } from "@/lib/api-client";
import {
  deleteCompany,
  listCompanies,
  putCompanies,
  humanizeCompanyError,
  type Company,
} from "@/lib/projects-ext-api";

/**
 * 我方公司主體名冊（模組五）。多數租戶只有一家，但集團型客戶可能用不同
 * 主體開票／收款（工程款與技師費分屬不同公司），故獨立成表整批編輯。
 * 沿用請款期程／副委託分期同一套「陣列整批 PUT」慣例：本地編輯完一次存檔。
 *
 * 生命週期（2026-10-10 業主拍板）：
 *   • 從沒被用過的公司可以「刪除」——走獨立的 DELETE，按下先確認，成功後重新載入名冊。
 *   • 被專案／放款／下包期款用過的公司不能刪（後端 `usage.total > 0`），改成「停用」：
 *     停用後新專案、新放款、新下包付款的下拉不再出現，舊紀錄照常顯示原公司名稱。
 *     「停用」跟其他欄位一樣是本地編輯、按「儲存」才送出（整批 PUT 的 `isActive`）。
 *   • 預設公司不能停用也不能刪；要先把預設改到其他公司（同一次存檔可以「換預設＋停用舊預設」）。
 *   • 還沒存檔的新列只是本地的，「移除」就沒了。
 */
type Row = Partial<Company> & {
  name: string;
  _key: string;
  /** 上次載入時它是不是預設公司；刪除鈕看這個（本地改了預設單選、還沒存檔之前，後端仍把它當預設）。 */
  _savedDefault?: boolean;
};

let seq = 0;
const newKey = () => `new-${Date.now()}-${seq++}`;

const fromCompanies = (cs: Company[]): Row[] =>
  cs.map((c) => ({ ...c, _key: c.id, _savedDefault: c.isDefault }));

const DEFAULT_CANNOT_DEACTIVATE = "預設公司不能停用，請先把預設改到其他公司";

/** 後端回這些代碼代表畫面上的使用量／預設狀態已經過期，要重新載入。 */
const STALE_CODES = new Set(["company_in_use", "company_is_default", "not_found"]);

function usageHint(r: Row): string {
  const u = r.usage;
  if (!u) return "";
  return `專案 ${u.projects}、放款單 ${u.disbursements}、下包期款 ${u.subcontractPayments}`;
}

export default function CompaniesPage() {
  const [rows, setRows] = useState<Row[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  /** 畫面上有沒有尚未儲存的修改；刪除成功後會重新載入，要提醒這些修改會被重設。 */
  const [dirty, setDirty] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await listCompanies();
      setRows(fromCompanies(r.companies));
      setDirty(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "載入失敗");
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  function patch(key: string, p: Partial<Row>) {
    setRows((rs) => rs.map((r) => (r._key === key ? { ...r, ...p } : r)));
    setDirty(true);
  }
  function setDefault(key: string) {
    // 停用的公司不能當預設（後端也會擋：400 default_company_inactive）。
    if (rows.find((r) => r._key === key)?.isActive === false) return;
    setRows((rs) => rs.map((r) => ({ ...r, isDefault: r._key === key })));
    setDirty(true);
  }
  function toggleInactive(r: Row) {
    // 預設公司不能停用（按鈕本身也是 disabled；這裡再擋一次）。
    if (r.isDefault && r.isActive !== false) return;
    patch(r._key, { isActive: r.isActive === false });
  }
  function addRow() {
    setRows((rs) => [...rs, { _key: newKey(), name: "", taxId: "", bankName: "", bankAccount: "", isDefault: rs.length === 0 }]);
    setDirty(true);
  }
  function removeRow(key: string) {
    setRows((rs) => rs.filter((r) => r._key !== key));
    setDirty(true);
  }

  async function save() {
    setSaving(true);
    setError(null);
    setSavedAt(null);
    try {
      const body = rows
        .filter((r) => r.name.trim())
        .map((r) => ({
          ...(r.id ? { id: r.id } : {}),
          name: r.name.trim(),
          taxId: r.taxId?.trim() || null,
          bankName: r.bankName?.trim() || null,
          bankAccount: r.bankAccount?.trim() || null,
          isDefault: !!r.isDefault,
          isActive: r.isActive !== false,
        }));
      const res = await putCompanies(body);
      setRows(fromCompanies(res.companies));
      setDirty(false);
      setSavedAt(Date.now());
    } catch (err) {
      setError(humanizeCompanyError(err, "儲存失敗"));
    } finally {
      setSaving(false);
    }
  }

  /** 刪除一間從沒被用過的公司：先確認，成功後重新載入（使用量與預設狀態都以後端為準）。 */
  async function remove(r: Row) {
    if (!r.id) return;
    const unsaved = dirty ? "\n（畫面上尚未儲存的修改會一併重設）" : "";
    if (!confirm(`確定刪除「${r.name}」？刪除後無法復原。${unsaved}`)) return;
    setDeletingId(r.id);
    setError(null);
    setSavedAt(null);
    try {
      await deleteCompany(r.id);
      await load();
    } catch (err) {
      const message = humanizeCompanyError(err, "刪除失敗");
      // 使用量或預設狀態在這段時間變了：重新載入，畫面才不會繼續顯示過期的「刪除」鈕。
      if (STALE_CODES.has((err as ApiError).code ?? "")) await load();
      setError(message);
    } finally {
      setDeletingId(null);
    }
  }

  return (
    <>
      {error && <div className="mb-3"><ErrorText>{error}</ErrorText></div>}

      <Card>
        {loading ? (
          <Empty>載入中…</Empty>
        ) : rows.length === 0 ? (
          <Empty>尚無主體，請新增一列。</Empty>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left text-xs text-gray-500">
                  <th className="py-2 pr-3">名稱 *</th>
                  <th className="py-2 pr-3">統一編號</th>
                  <th className="py-2 pr-3">銀行</th>
                  <th className="py-2 pr-3">帳號</th>
                  <th className="py-2 pr-3 text-center">預設</th>
                  <th className="py-2 pr-3 text-center">停用</th>
                  <th className="py-2"></th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const inactive = r.isActive === false;
                  const dim = inactive ? " opacity-60" : "";
                  const used = r.usage?.total ?? 0;
                  const protectedDefault = !!r.isDefault || !!r._savedDefault;
                  return (
                    <tr key={r._key} className={`border-b last:border-0${inactive ? " bg-gray-50" : ""}`} data-inactive={inactive ? "true" : undefined}>
                      <td className="py-1.5 pr-3">
                        <div className="flex items-center gap-2">
                          <input className={`${inputCls}${dim}`} value={r.name} onChange={(e) => patch(r._key, { name: e.target.value })} placeholder="公司名稱" />
                          {inactive && <span className="shrink-0 rounded bg-gray-200 px-1.5 py-0.5 text-[11px] text-gray-600">已停用</span>}
                        </div>
                      </td>
                      <td className="py-1.5 pr-3">
                        <input className={`${inputCls}${dim}`} value={r.taxId ?? ""} onChange={(e) => patch(r._key, { taxId: e.target.value })} placeholder="統編" />
                      </td>
                      <td className="py-1.5 pr-3">
                        <input className={`${inputCls}${dim}`} value={r.bankName ?? ""} onChange={(e) => patch(r._key, { bankName: e.target.value })} placeholder="銀行" />
                      </td>
                      <td className="py-1.5 pr-3">
                        <input className={`${inputCls}${dim}`} value={r.bankAccount ?? ""} onChange={(e) => patch(r._key, { bankAccount: e.target.value })} placeholder="帳號" />
                      </td>
                      <td className="py-1.5 pr-3 text-center">
                        <input
                          type="radio"
                          name="default-company"
                          checked={!!r.isDefault}
                          disabled={inactive}
                          title={inactive ? "已停用的公司不能設為預設，請先取消停用" : undefined}
                          aria-label={`設「${r.name || "未命名"}」為預設公司`}
                          onChange={() => setDefault(r._key)}
                        />
                      </td>
                      <td className="py-1.5 pr-3 text-center">
                        {r.id ? (
                          <input
                            type="checkbox"
                            checked={inactive}
                            disabled={!!r.isDefault && !inactive}
                            title={r.isDefault && !inactive ? DEFAULT_CANNOT_DEACTIVATE : inactive ? "取消停用（儲存後生效）" : "停用這間公司（儲存後生效）"}
                            aria-label={r.isDefault && !inactive ? `「${r.name}」是預設公司，${DEFAULT_CANNOT_DEACTIVATE}` : `停用「${r.name}」`}
                            onChange={() => toggleInactive(r)}
                          />
                        ) : (
                          <span className="text-xs text-gray-300">—</span>
                        )}
                      </td>
                      <td className="py-1.5 text-right">
                        {!r.id ? (
                          <button type="button" className="text-xs text-gray-400 hover:text-red-600" onClick={() => removeRow(r._key)}>移除</button>
                        ) : used > 0 ? (
                          <span className="text-xs text-gray-400" title={usageHint(r)}>
                            已被 {used} 筆紀錄使用，無法刪除{protectedDefault ? "" : "，可改為停用"}
                          </span>
                        ) : protectedDefault ? (
                          <span className="text-xs text-gray-400">預設公司不能刪除</span>
                        ) : (
                          <button
                            type="button"
                            className="text-xs text-gray-500 hover:text-red-600 disabled:opacity-50"
                            disabled={deletingId !== null || saving}
                            onClick={() => void remove(r)}
                          >
                            {deletingId === r.id ? "刪除中…" : "刪除"}
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        <div className="mt-4 flex flex-wrap items-center gap-3 border-t pt-4">
          <button type="button" className="rounded-lg border border-gray-200 px-3 py-1.5 text-sm text-gray-600 hover:bg-gray-50" onClick={addRow}>
            ＋ 新增一列
          </button>
          <PrimaryButton type="button" onClick={() => void save()} disabled={saving || deletingId !== null}>{saving ? "儲存中…" : "儲存"}</PrimaryButton>
          {savedAt && <span className="text-sm text-green-700">已儲存</span>}
          <span className="text-xs text-gray-400">
            名稱、統編、銀行、預設與停用都按「儲存」一次送出。從沒被用過的公司可以直接刪除；用過的公司不能刪，可改為停用——
            停用後新專案、新放款、新下包付款的下拉不再出現，舊紀錄照常顯示原公司名稱。預設公司不能停用也不能刪，要先把預設改到其他公司。
          </span>
        </div>
      </Card>
    </>
  );
}
