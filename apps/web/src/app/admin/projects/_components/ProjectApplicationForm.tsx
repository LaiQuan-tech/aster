"use client";

import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";
import { ClientCombo } from "@/components/ClientCombo";
import { VendorCombo } from "@/components/VendorCombo";
import { ErrorText, PrimaryButton, inputCls, labelCls } from "@/components/admin-ui";
import type { Department, Employee } from "@/lib/admin-api";
import type { Vendor } from "@/lib/company-api";
import {
  CLIENT_CATEGORY_LABELS,
  CLIENT_CATEGORY_ORDER,
  INVOICE_TYPE_LABELS,
  PAYMENT_METHOD_LABELS,
  PROJECT_KIND_LABELS,
  PROJECT_KIND_ORDER,
  disciplineLabel,
  type Client,
  type ClientCategory,
  type ClientInput,
  type CreateProjectExtBody,
  type InvoiceType,
  type PaymentMethod,
  type ProjectListItem,
} from "@/lib/projects-ext-api";
import {
  emptyProjectApplicationDraft,
  projectApplicationAmounts,
  projectApplicationErrors,
  projectApplicationSchedule,
  projectApplicationVisibility,
  toAuthorizedCreateProjectBody,
  type ProjectApplicationDraft,
} from "./project-application-form";

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="border border-slate-300">
      <h3 className="border-b border-slate-300 bg-cyan-50 px-4 py-2 text-center text-base font-bold tracking-[0.18em] text-slate-800">
        {title}
      </h3>
      <div className="p-4">{children}</div>
    </section>
  );
}

function money(value: number | null): string {
  return value == null ? "—" : value.toLocaleString("zh-TW");
}

interface ProjectApplicationFormProps {
  clients: Client[];
  departments: Department[];
  employees: Employee[];
  vendors: Vendor[];
  disciplines: string[];
  mainProjects: ProjectListItem[];
  vatRate: number;
  canFinance: boolean;
  canBonus: boolean;
  saving: boolean;
  apiError: string | null;
  onSubmit: (body: CreateProjectExtBody) => Promise<void>;
  onCreateClient: (body: ClientInput) => Promise<Client>;
}

export function ProjectApplicationForm({
  clients,
  departments,
  employees,
  vendors,
  disciplines,
  mainProjects,
  vatRate,
  canFinance,
  canBonus,
  saving,
  apiError,
  onSubmit,
  onCreateClient,
}: ProjectApplicationFormProps) {
  const [draft, setDraft] = useState<ProjectApplicationDraft>(() =>
    emptyProjectApplicationDraft(new Date().toLocaleDateString("sv-SE"), disciplines),
  );
  const [formErrors, setFormErrors] = useState<string[]>([]);
  const [showNewClient, setShowNewClient] = useState(false);
  const [newClientName, setNewClientName] = useState("");
  const [newClientTaxId, setNewClientTaxId] = useState("");
  const [newClientPhone, setNewClientPhone] = useState("");
  const [newClientCategory, setNewClientCategory] = useState<ClientCategory | "">("");
  const [creatingClient, setCreatingClient] = useState(false);

  useEffect(() => {
    setDraft((current) => ({
      ...current,
      engineers: Object.fromEntries(
        disciplines.map((discipline) => [discipline, current.engineers[discipline] ?? { vendorId: "", name: "", amount: "" }]),
      ),
    }));
  }, [disciplines]);

  const selectedClient = clients.find((client) => client.id === draft.clientId) ?? null;
  const amounts = useMemo(() => projectApplicationAmounts(draft, vatRate), [draft, vatRate]);
  const schedule = useMemo(() => projectApplicationSchedule(draft), [draft]);
  const visibility = projectApplicationVisibility({ canFinance, canBonus });

  function patch<K extends keyof ProjectApplicationDraft>(key: K, value: ProjectApplicationDraft[K]) {
    setDraft((current) => ({ ...current, [key]: value }));
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const errors = projectApplicationErrors(draft);
    setFormErrors(errors);
    if (errors.length > 0) return;
    await onSubmit(toAuthorizedCreateProjectBody(draft, { canFinance, canBonus }));
  }

  async function submitNewClient() {
    if (!newClientName.trim()) return;
    setCreatingClient(true);
    try {
      const client = await onCreateClient({
        name: newClientName.trim(),
        category: newClientCategory || null,
        taxId: newClientTaxId.trim() || null,
        phone: newClientPhone.trim() || null,
      });
      patch("clientId", client.id);
      setShowNewClient(false);
      setNewClientName("");
      setNewClientTaxId("");
      setNewClientPhone("");
      setNewClientCategory("");
    } catch {
      // 呼叫端會把 API 錯誤顯示在表單底部；這裡只確保 void click handler 不產生未處理 rejection。
    } finally {
      setCreatingClient(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-4">
      <div className="border-b-2 border-slate-800 pb-3 text-slate-900">
        <div className="flex flex-wrap items-end justify-between gap-2">
          <div>
            <p className="text-2xl font-black tracking-wide text-[#1f4f7a]">ASTER</p>
            <p className="text-sm">亞斯特設計顧問有限公司</p>
          </div>
          <h2 className="text-xl font-bold tracking-[0.2em]">專案申請單</h2>
          <div className="grid grid-cols-[auto_12rem] items-center gap-2 text-sm">
            <span>開案日期</span>
            <input className={inputCls} type="date" value={draft.openedOn} onChange={(event) => patch("openedOn", event.target.value)} />
          </div>
        </div>
        <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div>
            <label className={labelCls}>工程名稱 *</label>
            <input className={inputCls} value={draft.name} onChange={(event) => patch("name", event.target.value)} placeholder="請輸入工程名稱" />
          </div>
          <div>
            <label className={labelCls}>專案序號</label>
            <input className={inputCls} value={draft.code} onChange={(event) => patch("code", event.target.value)} placeholder="留空由系統自動產生" />
          </div>
        </div>
      </div>

      <Section title="專案明細">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div>
            <label className={labelCls}>設計地點</label>
            <input className={inputCls} value={draft.siteAddress} onChange={(event) => patch("siteAddress", event.target.value)} />
          </div>
          <div>
            <label className={labelCls}>設計面積</label>
            <div className="flex items-center gap-2"><input className={inputCls} type="number" min="0" step="any" value={draft.siteAreaM2} onChange={(event) => patch("siteAreaM2", event.target.value)} /><span className="text-sm text-slate-500">m²</span></div>
          </div>
        </div>
        <div className="mt-4">
          <div className="mb-2 flex items-center justify-between">
            <label className={labelCls}>設計內容（科別／服務項目）</label>
            <button type="button" className="text-sm text-[#1f4f7a]" onClick={() => patch("designScope", [...draft.designScope, { discipline: "", item: "", amount: "" }])}>＋ 新增一列</button>
          </div>
          <div className="space-y-2">
            {draft.designScope.map((row, index) => (
              <div key={index} className="grid grid-cols-1 gap-2 sm:grid-cols-[1fr_2fr_10rem_auto]">
                <input className={inputCls} list="project-discipline-options" value={row.discipline} placeholder="科別" onChange={(event) => patch("designScope", draft.designScope.map((item, rowIndex) => rowIndex === index ? { ...item, discipline: event.target.value } : item))} />
                <input className={inputCls} value={row.item} placeholder="服務項目" onChange={(event) => patch("designScope", draft.designScope.map((item, rowIndex) => rowIndex === index ? { ...item, item: event.target.value } : item))} />
                {visibility.showFinanceFields ? <input className={inputCls} type="number" min="0" value={row.amount} placeholder="金額" onChange={(event) => patch("designScope", draft.designScope.map((item, rowIndex) => rowIndex === index ? { ...item, amount: event.target.value } : item))} /> : <span />}
                <button type="button" className="px-2 text-sm text-red-500" onClick={() => patch("designScope", draft.designScope.filter((_, rowIndex) => rowIndex !== index))}>移除</button>
              </div>
            ))}
          </div>
          <datalist id="project-discipline-options">{disciplines.map((discipline) => <option key={discipline} value={discipline} />)}</datalist>
        </div>
      </Section>

      <Section title="客戶與發票資料">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div className="sm:col-span-2">
            <label className={labelCls}>客戶名稱</label>
            <div className="flex flex-wrap items-start gap-2">
              <ClientCombo clients={clients} clientId={draft.clientId || null} onChange={(id) => patch("clientId", id ?? "")} />
              <button type="button" className="rounded-md border border-slate-300 px-3 py-2 text-sm" onClick={() => setShowNewClient((current) => !current)}>{showNewClient ? "取消新增客戶" : "＋ 新增客戶"}</button>
            </div>
          </div>
          {showNewClient ? (
            <div className="grid grid-cols-1 gap-2 rounded-lg border border-dashed border-slate-300 p-3 sm:col-span-2 sm:grid-cols-5">
              <input className={inputCls} value={newClientName} onChange={(event) => setNewClientName(event.target.value)} placeholder="客戶名稱 *" />
              <select className={inputCls} value={newClientCategory} onChange={(event) => setNewClientCategory(event.target.value as ClientCategory | "")}><option value="">分類</option>{CLIENT_CATEGORY_ORDER.map((category) => <option key={category} value={category}>{CLIENT_CATEGORY_LABELS[category]}</option>)}</select>
              <input className={inputCls} value={newClientTaxId} onChange={(event) => setNewClientTaxId(event.target.value)} placeholder="統編" />
              <input className={inputCls} value={newClientPhone} onChange={(event) => setNewClientPhone(event.target.value)} placeholder="電話" />
              <PrimaryButton type="button" onClick={() => void submitNewClient()} disabled={creatingClient || !newClientName.trim()}>{creatingClient ? "建立中…" : "建立並選用"}</PrimaryButton>
            </div>
          ) : null}
          <div><label className={labelCls}>發票地址</label><div className={`${inputCls} min-h-10 bg-slate-50 text-slate-600`}>{selectedClient?.invoiceAddress || "—"}</div></div>
          <div><label className={labelCls}>電話／傳真</label><div className={`${inputCls} min-h-10 bg-slate-50 text-slate-600`}>{[selectedClient?.phone, selectedClient?.fax].filter(Boolean).join(" ／ ") || "—"}</div></div>
          <div><label className={labelCls}>採購承辦</label><div className={`${inputCls} min-h-10 bg-slate-50 text-slate-600`}>{[selectedClient?.contactName, selectedClient?.contactPhone].filter(Boolean).join(" ／ ") || "—"}</div></div>
          <div><label className={labelCls}>統一編號</label><div className={`${inputCls} min-h-10 bg-slate-50 text-slate-600`}>{selectedClient?.taxId || "—"}</div></div>
          <div><label className={labelCls}>發票聯式</label><select className={inputCls} value={draft.invoiceType} onChange={(event) => patch("invoiceType", event.target.value as InvoiceType | "")}><option value="">沿用客戶預設{selectedClient?.invoiceType ? `（${INVOICE_TYPE_LABELS[selectedClient.invoiceType]}）` : ""}</option>{(Object.keys(INVOICE_TYPE_LABELS) as InvoiceType[]).map((value) => <option key={value} value={value}>{INVOICE_TYPE_LABELS[value]}</option>)}</select></div>
          <div><label className={labelCls}>付款方式</label><select className={inputCls} value={draft.paymentMethod} onChange={(event) => patch("paymentMethod", event.target.value as PaymentMethod | "")}><option value="">沿用客戶預設{selectedClient?.paymentMethod ? `（${PAYMENT_METHOD_LABELS[selectedClient.paymentMethod]}）` : ""}</option>{(Object.keys(PAYMENT_METHOD_LABELS) as PaymentMethod[]).map((value) => <option key={value} value={value}>{PAYMENT_METHOD_LABELS[value]}</option>)}</select></div>
          <div><label className={labelCls}>結帳日</label><input className={inputCls} value={draft.closingDay} onChange={(event) => patch("closingDay", event.target.value)} placeholder={selectedClient?.closingDay ?? "例：每月 5 日"} /></div>
          <div><label className={labelCls}>付款日</label><input className={inputCls} value={draft.paymentDay} onChange={(event) => patch("paymentDay", event.target.value)} placeholder={selectedClient?.paymentDay ?? "例：次月 10 日"} /></div>
        </div>
      </Section>

      {visibility.showFinanceFields ? (
        <Section title="銷售金額">
          <div className="grid grid-cols-1 overflow-hidden border border-slate-300 text-center sm:grid-cols-3">
            <label className="border-b border-slate-300 sm:border-b-0 sm:border-r"><span className="block bg-slate-50 px-3 py-2 font-semibold">合約金額（未稅）</span><input className="w-full border-t border-slate-300 px-3 py-3 text-right" type="number" min="0" value={draft.contractAmount} onChange={(event) => patch("contractAmount", event.target.value)} placeholder="可直接輸入" /></label>
            <div className="border-b border-slate-300 sm:border-b-0 sm:border-r"><span className="block bg-slate-50 px-3 py-2 font-semibold">營業稅（{vatRate * 100}%）</span><p className="px-3 py-3 text-right tabular-nums">{money(amounts.taxAmount)}</p></div>
            <div><span className="block bg-slate-50 px-3 py-2 font-semibold">含稅總額</span><p className="px-3 py-3 text-right font-semibold tabular-nums">{money(amounts.amountTotal)}</p></div>
          </div>
        </Section>
      ) : null}

      {visibility.showFinanceFields ? (
        <Section title="付款階段">
          <div className="mb-3 flex flex-wrap gap-3 text-sm">
            <span className={`rounded-full px-3 py-1 font-medium ${schedule.percentageTotal > 100 ? "bg-red-50 text-red-700" : "bg-slate-100 text-slate-700"}`}>一般期款比例合計 {schedule.percentageTotal}%</span>
            <span className="rounded-full bg-slate-100 px-3 py-1 text-slate-700">一般期款合計 {money(schedule.effectiveTotal)}</span>
            {schedule.rows.some((row) => row.residueApplied !== 0) ? <span className="rounded-full bg-amber-50 px-3 py-1 text-amber-700">末期已吸收尾差</span> : null}
          </div>
          <div className="overflow-x-auto">
            <table className="min-w-[980px] w-full border-collapse text-sm">
              <thead><tr className="bg-slate-50"><th className="border border-slate-300 p-2">期別</th><th className="border border-slate-300 p-2">名稱</th><th className="border border-slate-300 p-2">%</th><th className="border border-slate-300 p-2">預估金額</th><th className="border border-slate-300 p-2">指定金額</th><th className="border border-slate-300 p-2">指定理由</th><th className="border border-slate-300 p-2">預計日</th><th className="border border-slate-300 p-2">備註</th></tr></thead>
              <tbody>{draft.billings.map((row, index) => {
                const computed = schedule.rows.find((item) => item.installmentNo === row.installmentNo);
                const update = (next: Partial<(typeof draft.billings)[number]>) => patch("billings", draft.billings.map((item, rowIndex) => rowIndex === index ? { ...item, ...next } : item));
                return <tr key={row.installmentNo}><td className="border border-slate-300 p-2 text-center">{row.installmentNo}</td><td className="border border-slate-300 p-1"><input className={inputCls} value={row.milestone} onChange={(event) => update({ milestone: event.target.value })} /></td><td className="border border-slate-300 p-1"><input className={inputCls} type="number" min="0" max="100" step="any" value={row.percentage} onChange={(event) => update({ percentage: event.target.value })} /></td><td className={`border border-slate-300 p-2 text-right tabular-nums ${(computed?.effectiveAmount ?? 0) < 0 ? "bg-red-50 text-red-700" : ""}`}>{money(computed?.effectiveAmount ?? null)}{computed?.residueApplied ? <span className="ml-1 block text-[10px] text-amber-700">尾差 {computed.residueApplied > 0 ? "+" : ""}{computed.residueApplied.toLocaleString()}</span> : null}</td><td className="border border-slate-300 p-1"><input className={inputCls} type="number" min="0" value={row.overrideAmount} onChange={(event) => update({ overrideAmount: event.target.value })} /></td><td className="border border-slate-300 p-1"><input className={inputCls} value={row.overrideReason} onChange={(event) => update({ overrideReason: event.target.value })} /></td><td className="border border-slate-300 p-1"><input className={inputCls} type="date" value={row.plannedOn} onChange={(event) => update({ plannedOn: event.target.value })} /></td><td className="border border-slate-300 p-1"><input className={inputCls} value={row.note} onChange={(event) => update({ note: event.target.value })} /></td></tr>;
              })}</tbody>
            </table>
          </div>
        </Section>
      ) : null}

      <Section title="協力技師／發包單位">
        <p className="mb-3 text-sm text-slate-500">此處建立申請單上的科別、協力單位與預估金額；正式發包合約、付款與代扣歷程須在建案後於「專案明細」建立。</p>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {disciplines.map((discipline) => {
            const assignment = draft.engineers[discipline] ?? { vendorId: "", name: "", amount: "" };
            return <div key={discipline}><p className="mb-1 text-sm font-medium text-slate-600">{disciplineLabel(discipline)}</p><VendorCombo vendors={vendors} vendorId={assignment.vendorId || null} name={assignment.name || null} onChange={(value) => patch("engineers", { ...draft.engineers, [discipline]: { ...assignment, vendorId: value.vendorId ?? "", name: value.name ?? "" } })} />{visibility.showFinanceFields ? <input className={`${inputCls} mt-1 text-xs`} type="number" min="0" value={assignment.amount} onChange={(event) => patch("engineers", { ...draft.engineers, [discipline]: { ...assignment, amount: event.target.value } })} placeholder="預估發包／技師金額" /> : null}</div>;
          })}
        </div>
      </Section>

      <Section title="發包與費用摘要">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div className="rounded-lg bg-slate-50 p-3 text-sm text-slate-500">上方金額只會寫入申請單的科別與費用明細，不會宣稱已建立下包期款；正式發包與付款請於建案後建立。</div>
          {visibility.showFinanceFields ? <div><label className={labelCls}>其他支出（差旅、規費等）</label><input className={inputCls} type="number" min="0" value={draft.otherExpenses} onChange={(event) => patch("otherExpenses", event.target.value)} /></div> : null}
        </div>
      </Section>

      <Section title="內部專案設定">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div><label className={labelCls}>歸屬年度</label><input className={inputCls} type="number" min="1" max="2100" value={draft.fiscalYear} onChange={(event) => patch("fiscalYear", event.target.value)} placeholder="可填西元年或民國年" /></div>
          <div><label className={labelCls}>案件類型</label><select className={inputCls} value={draft.kind} onChange={(event) => patch("kind", event.target.value as ProjectApplicationDraft["kind"])}>{PROJECT_KIND_ORDER.map((kind) => <option key={kind} value={kind}>{PROJECT_KIND_LABELS[kind]}</option>)}</select></div>
          {draft.kind !== "main" ? <div><label className={labelCls}>母案 *</label><select className={inputCls} value={draft.parentProjectId} onChange={(event) => patch("parentProjectId", event.target.value)}><option value="">請選擇母案</option>{mainProjects.map((project) => <option key={project.id} value={project.id}>{project.code ? `${project.code}　` : ""}{project.name}</option>)}</select></div> : null}
          <div><label className={labelCls}>所屬部門</label><select className={inputCls} value={draft.deptId} onChange={(event) => patch("deptId", event.target.value)}><option value="">不指定</option>{departments.map((department) => <option key={department.id} value={department.id}>{department.name}</option>)}</select></div>
          <div><label className={labelCls}>專案負責人</label><select className={inputCls} value={draft.leadEmpId} onChange={(event) => patch("leadEmpId", event.target.value)}><option value="">不指定</option>{employees.map((employee) => <option key={employee.id} value={employee.id}>{employee.name}{employee.emp_no ? `（${employee.emp_no}）` : ""}</option>)}</select></div>
          {visibility.showBonusFields ? <div><label className={labelCls}>分潤模式</label><select className={inputCls} value={draft.shareMode} onChange={(event) => patch("shareMode", event.target.value as ProjectApplicationDraft["shareMode"])}><option value="pool_pct">獎金池 × 百分比</option><option value="fixed_amount">直接填每人金額</option></select></div> : null}
          {draft.shareMode === "pool_pct" && visibility.showBonusFields ? <div><label className={labelCls}>獎金池總額</label><input className={inputCls} type="number" min="0" value={draft.bonusPool} onChange={(event) => patch("bonusPool", event.target.value)} /></div> : null}
          <div><label className={labelCls}>預定開始日</label><input className={inputCls} type="date" value={draft.startsOn} onChange={(event) => patch("startsOn", event.target.value)} /></div>
          <div><label className={labelCls}>預定結束日</label><input className={inputCls} type="date" value={draft.endsOn} onChange={(event) => patch("endsOn", event.target.value)} /></div>
          <div className="sm:col-span-2"><label className={labelCls}>說明</label><textarea className={inputCls} rows={3} value={draft.description} onChange={(event) => patch("description", event.target.value)} /></div>
        </div>
      </Section>

      {formErrors.length > 0 ? <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700"><ul className="list-disc pl-5">{formErrors.map((message) => <li key={message}>{message}</li>)}</ul></div> : null}
      <ErrorText>{apiError}</ErrorText>
      <div className="flex justify-end"><PrimaryButton type="submit" disabled={saving}>{saving ? "建立中…" : "建立專案並開啟明細"}</PrimaryButton></div>
    </form>
  );
}
