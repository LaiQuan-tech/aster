"use client";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Card, Empty, ErrorText, PrimaryButton, inputCls, labelCls } from "@/components/admin-ui";
import { apiDownload } from "@/lib/api-client";
import { getEmployees, getBranding, saveTenantSettings, type Employee, type TenantFeatures } from "@/lib/admin-api";
import { getMailboxes, putMailbox, MAILBOX_STATUS_LABEL, type Mailbox, type MailboxStatus } from "@/lib/company-api";

/**
 * 專屬 Email 配發：台帳 + 匯出。信箱本身在郵件供應商（Google Workspace / Microsoft 365）
 * 那邊建——要系統代建得拿網域管理員憑證，那是另一個決定；這頁先把「誰該有、地址是什麼、
 * 建了沒、何時停」管起來，並匯出供應商批次匯入格式的 CSV，建完回來標「使用中」。
 * 離職員工（status 非 active）預設建議停用。
 */
const STATUS_CLS: Record<MailboxStatus, string> = {
  planned: "bg-amber-50 text-amber-700",
  active: "bg-green-50 text-green-700",
  suspended: "bg-gray-100 text-gray-500",
};

function suggestLocalPart(e: Employee, rule: "emp_no" | "manual"): string {
  if (rule === "emp_no" && e.emp_no) return e.emp_no.toLowerCase().replace(/[^a-z0-9._-]/g, "");
  return "";
}

export default function EmployeeMailPage() {
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [boxes, setBoxes] = useState<Mailbox[]>([]);
  const [features, setFeatures] = useState<TenantFeatures | null>(null);
  const [domain, setDomain] = useState("");
  const [rule, setRule] = useState<"emp_no" | "manual">("emp_no");
  const [provider, setProvider] = useState<"google" | "microsoft" | "other">("google");
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [e, b, t] = await Promise.all([getEmployees(), getMailboxes(), getBranding()]);
      setEmployees(e.employees);
      setBoxes(b.mailboxes);
      setFeatures(t.features);
      const mail = t.features?.mail;
      if (mail?.domain) setDomain(mail.domain);
      if (mail?.rule) setRule(mail.rule);
      if (mail?.provider) setProvider(mail.provider);
    } catch (err) {
      setError(err instanceof Error ? err.message : "載入失敗");
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const boxByEmp = useMemo(() => new Map(boxes.map((b) => [b.employeeId, b])), [boxes]);
  const rows = useMemo(
    () => [...employees].sort((a, b) => (a.emp_no ?? "").localeCompare(b.emp_no ?? "") || a.name.localeCompare(b.name)),
    [employees],
  );
  const stats = useMemo(() => {
    const s = { none: 0, planned: 0, active: 0, suspended: 0 };
    for (const e of employees) {
      const b = boxByEmp.get(e.id);
      if (!b) s.none += 1;
      else s[b.status] += 1;
    }
    return s;
  }, [employees, boxByEmp]);

  async function saveSettings() {
    setBusy("settings");
    setMsg(null);
    try {
      await saveTenantSettings({ features: { ...(features ?? {}), mail: { domain: domain.trim().toLowerCase(), rule, provider } } });
      setMsg("設定已儲存");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "儲存失敗");
    } finally {
      setBusy(null);
    }
  }

  function draftFor(e: Employee): string {
    if (drafts[e.id] !== undefined) return drafts[e.id];
    const existing = boxByEmp.get(e.id);
    if (existing) return existing.address.split("@")[0];
    return suggestLocalPart(e, rule);
  }

  async function assign(e: Employee, status?: MailboxStatus) {
    const local = draftFor(e).trim().toLowerCase();
    if (!domain.trim()) {
      setError("先在上方設定公司網域");
      return;
    }
    if (!local) {
      setError(`${e.name}：請填地址的 @ 前半`);
      return;
    }
    setBusy(e.id);
    setError(null);
    try {
      const existing = boxByEmp.get(e.id);
      await putMailbox(e.id, {
        address: `${local}@${domain.trim().toLowerCase()}`,
        status: status ?? existing?.status ?? "planned",
        provider,
      });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "儲存失敗");
    } finally {
      setBusy(null);
    }
  }

  async function assignAllMissing() {
    const targets = rows.filter((e) => !boxByEmp.get(e.id) && e.status === "active" && draftFor(e).trim());
    if (targets.length === 0) return;
    if (!confirm(`為 ${targets.length} 位尚未配發的在職員工建立「待建立」的地址？`)) return;
    for (const e of targets) await assign(e, "planned");
  }

  return (
    <>
      {error && <div className="mb-3"><ErrorText>{error}</ErrorText></div>}

      <Card>
        <h2 className="mb-3 text-sm font-semibold text-gray-700">網域與規則</h2>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-4">
          <div>
            <label className={labelCls}>公司網域</label>
            <input className={inputCls} value={domain} onChange={(e) => setDomain(e.target.value)} placeholder="example.com.tw" />
          </div>
          <div>
            <label className={labelCls}>地址預設規則</label>
            <select className={inputCls} value={rule} onChange={(e) => setRule(e.target.value as "emp_no" | "manual")}>
              <option value="emp_no">工號@網域</option>
              <option value="manual">逐人手填</option>
            </select>
          </div>
          <div>
            <label className={labelCls}>郵件供應商</label>
            <select className={inputCls} value={provider} onChange={(e) => setProvider(e.target.value as typeof provider)}>
              <option value="google">Google Workspace</option>
              <option value="microsoft">Microsoft 365</option>
              <option value="other">其他</option>
            </select>
          </div>
          <div className="flex items-end">
            <PrimaryButton type="button" onClick={() => void saveSettings()} disabled={busy === "settings"}>儲存設定</PrimaryButton>
          </div>
        </div>
        {msg && <p className="mt-2 text-sm text-green-700">{msg}</p>}
        <p className="mt-2 text-xs text-gray-400">系統不代建信箱：匯出 CSV 到供應商後台批次建立，建好回來把狀態改成「使用中」。要接供應商 API 自動建立，需要網域管理員憑證，另議。</p>
      </Card>

      <Card>
        <div className="mb-3 flex flex-wrap items-center gap-3">
          <h2 className="text-sm font-semibold text-gray-700">配發台帳</h2>
          <span className="text-sm text-gray-500">未配 {stats.none}・待建立 {stats.planned}・使用中 {stats.active}・已停用 {stats.suspended}</span>
          <div className="ml-auto flex gap-2">
            <button type="button" onClick={() => void assignAllMissing()} className="rounded-md border border-gray-300 px-3 py-1.5 text-sm text-gray-700" disabled={!domain.trim() || rule === "manual"}>
              一鍵配發未配的在職員工
            </button>
            <button type="button" onClick={() => apiDownload(`/employee-mailboxes/export?provider=${provider === "microsoft" ? "microsoft" : "google"}`, `mailboxes_${provider}.csv`).catch((e) => setError(e.message))} className="rounded-md border border-gray-300 px-3 py-1.5 text-sm text-gray-700" disabled={stats.planned === 0}>
              匯出待建立（{provider === "microsoft" ? "Microsoft 365" : "Google Workspace"} 格式）
            </button>
          </div>
        </div>
        {rows.length === 0 ? (
          <Empty>沒有員工</Empty>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left text-xs text-gray-500">
                  <th className="py-2 pr-3">員工</th>
                  <th className="py-2 pr-3">在職</th>
                  <th className="py-2 pr-3">信箱地址</th>
                  <th className="py-2 pr-3">狀態</th>
                  <th className="py-2 pr-3">日期</th>
                  <th className="py-2"></th>
                </tr>
              </thead>
              <tbody>
                {rows.map((e) => {
                  const b = boxByEmp.get(e.id);
                  const local = draftFor(e);
                  const changed = b ? local !== b.address.split("@")[0] : local !== "";
                  return (
                    <tr key={e.id} className="border-b last:border-0">
                      <td className="py-2 pr-3 font-medium text-gray-900">{e.emp_no ? `${e.emp_no} · ` : ""}{e.name}</td>
                      <td className="py-2 pr-3 text-xs text-gray-500">{e.status === "active" ? "在職" : e.status}</td>
                      <td className="py-2 pr-3">
                        <span className="inline-flex items-center gap-1">
                          <input className="w-40 rounded-md border border-gray-300 px-2 py-1 text-sm" value={local}
                            onChange={(ev) => setDrafts((d) => ({ ...d, [e.id]: ev.target.value }))} placeholder="@ 前半" disabled={b?.status === "suspended"} />
                          <span className="text-gray-500">@{domain || "網域"}</span>
                        </span>
                      </td>
                      <td className="py-2 pr-3">
                        {b ? <span className={`rounded-full px-2 py-0.5 text-xs ${STATUS_CLS[b.status]}`}>{MAILBOX_STATUS_LABEL[b.status]}</span> : <span className="text-xs text-gray-400">未配發</span>}
                      </td>
                      <td className="py-2 pr-3 text-xs text-gray-500">
                        {b?.status === "active" && b.activatedOn ? `啟用 ${b.activatedOn}` : b?.status === "suspended" && b.suspendedOn ? `停用 ${b.suspendedOn}` : "—"}
                      </td>
                      <td className="py-2 text-right whitespace-nowrap">
                        {!b || changed ? (
                          <button type="button" onClick={() => void assign(e)} disabled={busy === e.id || !local.trim()} className="text-sm font-medium disabled:opacity-50" style={{ color: "var(--brand)" }}>
                            {b ? "更新地址" : "配發"}
                          </button>
                        ) : b.status === "planned" ? (
                          <button type="button" onClick={() => void assign(e, "active")} disabled={busy === e.id} className="text-sm text-green-700 hover:underline">已建立 → 使用中</button>
                        ) : b.status === "active" ? (
                          <button type="button" onClick={() => { if (confirm(`停用 ${b.address}？`)) void assign(e, "suspended"); }} disabled={busy === e.id} className="text-sm text-gray-500 hover:underline">停用</button>
                        ) : (
                          <button type="button" onClick={() => void assign(e, "active")} disabled={busy === e.id} className="text-sm text-gray-500 hover:underline">重新啟用</button>
                        )}
                        {e.status !== "active" && b?.status === "active" && <span className="ml-2 text-xs text-amber-700">離職，建議停用</span>}
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
