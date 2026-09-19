"use client";
import { useCallback, useEffect, useState } from "react";
import { Card, Empty, ErrorText, PrimaryButton, inputCls, labelCls } from "@/components/admin-ui";
import { listCompanies, putCompanies, humanizeCompanyError, type Company } from "@/lib/projects-ext-api";

/**
 * 我方公司主體名冊（模組五）。多數租戶只有一家，但集團型客戶可能用不同
 * 主體開票／收款（工程款與技師費分屬不同公司），故獨立成表整批編輯。
 * 沿用請款期程／副委託分期同一套「陣列整批 PUT」慣例：本地編輯完一次存檔。
 *
 * ⚠️ 這支 PUT 是 upsert，**不會刪除**沒出現在陣列裡的既有主體（後端刻意如此
 * ——主體被下包期款引用，刪了對不到歷史付款人）。所以「移除」只對存檔前
 * 新增、還沒有 id 的列有效；已存在的主體按下移除後存檔仍會原樣出現。
 */
type Row = Partial<Company> & { name: string; _key: string };

let seq = 0;
const newKey = () => `new-${Date.now()}-${seq++}`;

const fromCompanies = (cs: Company[]): Row[] =>
  cs.map((c) => ({ ...c, _key: c.id }));

export default function CompaniesPage() {
  const [rows, setRows] = useState<Row[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await listCompanies();
      setRows(fromCompanies(r.companies));
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
  }
  function setDefault(key: string) {
    setRows((rs) => rs.map((r) => ({ ...r, isDefault: r._key === key })));
  }
  function addRow() {
    setRows((rs) => [...rs, { _key: newKey(), name: "", taxId: "", bankName: "", bankAccount: "", isDefault: rs.length === 0 }]);
  }
  function removeRow(key: string) {
    setRows((rs) => rs.filter((r) => r._key !== key));
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
        }));
      const res = await putCompanies(body);
      setRows(fromCompanies(res.companies));
      setSavedAt(Date.now());
    } catch (err) {
      setError(humanizeCompanyError(err, "儲存失敗"));
    } finally {
      setSaving(false);
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
                  <th className="py-2"></th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r._key} className="border-b last:border-0">
                    <td className="py-1.5 pr-3">
                      <input className={inputCls} value={r.name} onChange={(e) => patch(r._key, { name: e.target.value })} placeholder="公司名稱" />
                    </td>
                    <td className="py-1.5 pr-3">
                      <input className={inputCls} value={r.taxId ?? ""} onChange={(e) => patch(r._key, { taxId: e.target.value })} placeholder="統編" />
                    </td>
                    <td className="py-1.5 pr-3">
                      <input className={inputCls} value={r.bankName ?? ""} onChange={(e) => patch(r._key, { bankName: e.target.value })} placeholder="銀行" />
                    </td>
                    <td className="py-1.5 pr-3">
                      <input className={inputCls} value={r.bankAccount ?? ""} onChange={(e) => patch(r._key, { bankAccount: e.target.value })} placeholder="帳號" />
                    </td>
                    <td className="py-1.5 pr-3 text-center">
                      <input type="radio" name="default-company" checked={!!r.isDefault} onChange={() => setDefault(r._key)} />
                    </td>
                    <td className="py-1.5 pr-3 text-right">
                      {r.id ? (
                        <span className="text-xs text-gray-300" title="已存在的主體無法在此刪除；要停用請改名稱或在備註標記">—</span>
                      ) : (
                        <button type="button" className="text-xs text-gray-400 hover:text-red-600" onClick={() => removeRow(r._key)}>移除</button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <div className="mt-4 flex flex-wrap items-center gap-3 border-t pt-4">
          <button type="button" className="rounded-lg border border-gray-200 px-3 py-1.5 text-sm text-gray-600 hover:bg-gray-50" onClick={addRow}>
            ＋ 新增一列
          </button>
          <PrimaryButton type="button" onClick={() => void save()} disabled={saving}>{saving ? "儲存中…" : "儲存"}</PrimaryButton>
          {savedAt && <span className="text-sm text-green-700">已儲存</span>}
          <span className="text-xs text-gray-400">整批存檔；已存在的主體不會被刪除，只能改名稱／銀行資訊或切換預設。</span>
        </div>
      </Card>
    </>
  );
}
