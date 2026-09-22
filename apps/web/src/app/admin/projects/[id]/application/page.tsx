"use client";

import { useEffect, useState, type ReactNode } from "react";
import { useParams } from "next/navigation";
import { listVendors, type Vendor } from "@/lib/company-api";
import { DOC_TYPE_LABELS, OUR_ROLE_SHORT_LABELS, getContracts, type Contract } from "@/lib/projects-api";
import {
  getProjectApplication,
  formatRocDate,
  INVOICE_TYPE_LABELS,
  PAYMENT_METHOD_LABELS,
  disciplineLabel,
  engineerDisciplinesOf,
  BILLING_KIND_LABELS,
  type ApplicationData,
  type BillingExt,
  type Subcontract,
} from "@/lib/projects-ext-api";

function fmtMoney(n: number | null | undefined): string {
  return n == null ? "—" : n.toLocaleString();
}

/** 印花稅率以千分率呈現（承攬契據法定 1‰＝rate 0.001）；沒有費率回破折號。 */
function formatDutyRate(rate: number | null | undefined): string {
  if (rate == null) return "—";
  const permille = rate * 1000;
  return `${Number.isInteger(permille) ? permille : permille.toFixed(2)}‰`;
}

/** label/value 一格，客戶資料區用；長欄位（地址、內容）整列獨吞。 */
function Field({ label, value, full }: { label: string; value: string; full?: boolean }) {
  return (
    <div className={`flex border border-gray-400 ${full ? "col-span-2" : ""}`}>
      <span className="w-20 shrink-0 border-r border-gray-400 bg-gray-50 px-2 py-1 text-[11px] text-gray-600 print:bg-gray-100">{label}</span>
      <span className="flex-1 px-2 py-1 text-[11px]">{value || "—"}</span>
    </div>
  );
}

/** B6 分區列印：頁面上實際會出現的區塊 key／中文標籤，操作列勾選清單與各區塊
 * <section data-print-block> 都靠這份清單對起來。新增/移除可勾選的區塊只改這裡。 */
export type PrintBlockKey = "customer" | "sales" | "payment" | "engineers" | "subcontract" | "contracts";

export const PRINT_BLOCKS: { key: PrintBlockKey; label: string }[] = [
  { key: "customer", label: "客戶資料" },
  { key: "sales", label: "銷售金額" },
  { key: "payment", label: "付款階段" },
  { key: "engineers", label: "協力技師" },
  { key: "subcontract", label: "發包單位" },
  // M17（2026-09-23）：合約區塊原本只在專案明細頁的 ContractsCard，申請單印不出來。
  { key: "contracts", label: "合約與印花稅" },
];

const PRINT_BLOCKS_STORAGE_KEY = "print-blocks:project-application";

function defaultPrintChecked(): Record<PrintBlockKey, boolean> {
  const result = {} as Record<PrintBlockKey, boolean>;
  for (const { key } of PRINT_BLOCKS) result[key] = true;
  return result;
}

/** 區塊標題。該區塊被取消勾選時，螢幕上加一個淡化提示徽章；徽章本身標了
 * .no-print，實際列印時一定不出現，純粹讓操作的人知道「這塊等一下不會印」。 */
function SectionTitle({ children, hidden }: { children: ReactNode; hidden?: boolean }) {
  return (
    <h2 className="mb-1 mt-3 flex items-center gap-2 text-xs font-semibold text-gray-700">
      {children}
      {hidden && (
        <span className="no-print rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-normal text-amber-700">
          列印時不印
        </span>
      )}
    </h2>
  );
}

/**
 * 純呈現元件——不打 API，資料整包用 props 傳入。刻意抽出來是為了讓暫時的
 * 假資料預覽頁（截圖驗收用）跟正式頁共用同一份排版，驗完就能把暫時頁刪掉，
 * 排版本身留在這裡不受影響。
 *
 * printChecked 省略時全部視為勾選（維持這個元件單獨使用時的預設行為，不因為
 * B6 這個新功能而改變既有呼叫方式）。
 */
export function ApplicationDocument({
  data,
  printChecked,
  contracts,
  vendors,
}: {
  data: ApplicationData;
  printChecked?: Partial<Record<PrintBlockKey, boolean>>;
  /** M17：合約與印花稅區塊的資料；省略＝不畫那一區（純排版預覽用）。 */
  contracts?: Contract[];
  /**
   * 廠商名冊（GET /vendors）：協力技師只存 `vendorId` 時（專案頁用 VendorCombo 選名冊廠商，
   * API 存下來的 `name` 是 null）靠它對回名稱——2026-09-23 正式站驗收：已選廠商的四個科別欄全印「—」。
   * 省略＝只看 `name`。
   */
  vendors?: Vendor[];
}) {
  const { project, client, latestDocument, designScope, engineers, billings, subcontracts, money } = data;
  const isChecked = (key: PrintBlockKey) => printChecked?.[key] ?? true;
  /** 協力技師顯示名稱：有 name 用 name；沒有就用 vendorId 對回名冊；兩者皆無才是「—」（與專案頁 VendorCombo 一致：選了名冊廠商就顯示廠商名）。 */
  const vendorNameById = new Map((vendors ?? []).map((v) => [v.id, v.name]));
  const engineerName = (discipline: string): string => {
    const assignment = engineers?.[discipline];
    if (!assignment) return "—";
    const name = assignment.name?.trim();
    if (name) return name;
    return (assignment.vendorId && vendorNameById.get(assignment.vendorId)) || "—";
  };
  /**
   * 未勾選的區塊直接掛 `no-print`（globals.css 既有的全域規則），不必替每個
   * 新區塊在 CSS 裡多寫一條 `body.print-hide-<key>`。螢幕上仍淡化顯示。
   */
  const blockCls = (key: PrintBlockKey) => (isChecked(key) ? undefined : "no-print opacity-40");
  /** W8：協力技師欄位依租戶設定的科別；沒設定就用預設四科。 */
  const disciplines = engineerDisciplinesOf(data.settings?.disciplines);

  const installmentRows = billings
    .filter((b) => b.kind === "installment")
    .sort((a, b) => a.installmentNo - b.installmentNo);
  const guildRow = billings.find((b) => b.kind === "guild_advance") ?? null;
  // 付款階段固定 8 列——照舊版 Word 申請單的版面，第 8 列固定是技師公會代墊。
  const stageRows: Array<BillingExt | null> = [];
  for (let i = 0; i < 7; i++) stageRows.push(installmentRows[i] ?? null);
  stageRows.push(guildRow);

  // 發包單位固定 3 格，同樣是照舊版版面；超過 3 筆的下包仍完整存在系統裡，
  // 只是這張一頁式申請單只印前 3 筆，其餘請看專案頁的「副委託與協力技師」。
  const subRows: Array<Subcontract | null> = [0, 1, 2].map((i) => subcontracts[i] ?? null);

  const designContent =
    designScope.length > 0
      ? designScope.map((d) => `${d.discipline}${d.item ? `－${d.item}` : ""}`).join("、")
      : "—";

  const invoiceTypeLabel = project.invoiceType
    ? INVOICE_TYPE_LABELS[project.invoiceType]
    : client?.invoiceType
      ? `${INVOICE_TYPE_LABELS[client.invoiceType]}（客戶預設）`
      : "—";
  const paymentMethodLabel = project.paymentMethod
    ? PAYMENT_METHOD_LABELS[project.paymentMethod]
    : client?.paymentMethod
      ? `${PAYMENT_METHOD_LABELS[client.paymentMethod]}（客戶預設）`
      : "—";

  return (
    <div className="print-sheet mx-auto max-w-3xl bg-white p-6 text-gray-900 print:max-w-none print:p-0">
      <h1 className="text-center text-xl font-bold tracking-[0.3em]">專案申請單</h1>
      <div className="mt-2 flex flex-wrap items-center justify-between gap-2 border-b-2 border-gray-800 pb-2 text-xs">
        <span>開案日期：{formatRocDate(data.openedOn)}</span>
        <span>工程名稱：{project.name}</span>
        <span className="font-mono">專案序號：{data.code ?? "—"}</span>
      </div>

      <section data-print-block="customer" className={blockCls("customer")}>
        <SectionTitle hidden={!isChecked("customer")}>客戶資料</SectionTitle>
        <div className="grid grid-cols-2 gap-y-0 border-l border-t border-gray-400 [&>*]:border-r [&>*]:border-b">
          <Field label="設計地點" value={project.siteAddress ?? ""} full />
          <Field label="設計面積" value={project.siteAreaM2 != null ? `${project.siteAreaM2} m²` : ""} />
          <Field label="訂單類型" value={latestDocument ? DOC_TYPE_LABELS[latestDocument.docType] : ""} />
          <Field label="設計內容" value={designContent} full />
          <Field label="客戶名稱" value={client?.name ?? ""} />
          <Field label="統一編號" value={client?.taxId ?? ""} />
          <Field label="電話" value={client?.phone ?? ""} />
          <Field label="傳真" value={client?.fax ?? ""} />
          <Field label="發票地址" value={client?.invoiceAddress ?? ""} full />
          <Field label="採購承辦" value={[client?.contactName, client?.contactPhone].filter(Boolean).join(" / ")} />
          <Field label="發票聯式" value={invoiceTypeLabel} />
          <Field label="付款方式" value={paymentMethodLabel} />
          <Field label="結帳日／付款日" value={[project.closingDay ?? client?.closingDay, project.paymentDay ?? client?.paymentDay].filter(Boolean).join(" ／ ")} />
        </div>
      </section>

      <section data-print-block="sales" className={blockCls("sales")}>
        <SectionTitle hidden={!isChecked("sales")}>銷售金額</SectionTitle>
        <table className="w-full border-collapse border border-gray-400 text-center text-[11px]">
          <thead>
            <tr className="bg-gray-50 print:bg-gray-100">
              <th className="border border-gray-400 px-2 py-1">未稅金額</th>
              <th className="border border-gray-400 px-2 py-1">營業稅</th>
              <th className="border border-gray-400 px-2 py-1">含稅總額</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td className="border border-gray-400 px-2 py-1">{fmtMoney(money?.amountUntaxed)}</td>
              <td className="border border-gray-400 px-2 py-1">{fmtMoney(money?.taxAmount)}</td>
              <td className="border border-gray-400 px-2 py-1">{fmtMoney(money?.amountTotal)}</td>
            </tr>
          </tbody>
        </table>
      </section>

      <section data-print-block="payment" className={blockCls("payment")}>
        <SectionTitle hidden={!isChecked("payment")}>付款階段</SectionTitle>
        <table className="w-full border-collapse border border-gray-400 text-center text-[11px]">
          <thead>
            <tr className="bg-gray-50 print:bg-gray-100">
              <th className="border border-gray-400 px-2 py-1">期別</th>
              <th className="border border-gray-400 px-2 py-1">名稱</th>
              <th className="border border-gray-400 px-2 py-1">%</th>
              <th className="border border-gray-400 px-2 py-1">金額</th>
              <th className="border border-gray-400 px-2 py-1">入賬日</th>
              <th className="border border-gray-400 px-2 py-1">發票號碼</th>
            </tr>
          </thead>
          <tbody>
            {stageRows.map((row, i) => (
              <tr key={i}>
                <td className="border border-gray-400 px-2 py-1">{i + 1}</td>
                <td className="border border-gray-400 px-2 py-1">
                  {i === 7 ? (row?.milestone || BILLING_KIND_LABELS.guild_advance) : (row?.milestone || "—")}
                </td>
                <td className="border border-gray-400 px-2 py-1">{row?.percentage ?? "—"}</td>
                <td className="border border-gray-400 px-2 py-1">{fmtMoney(row?.effectiveAmount)}</td>
                <td className="border border-gray-400 px-2 py-1">{row?.receivedOn ?? "—"}</td>
                <td className="border border-gray-400 px-2 py-1">{row?.invoiceNo ?? "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section data-print-block="engineers" className={blockCls("engineers")}>
        <SectionTitle hidden={!isChecked("engineers")}>協力技師</SectionTitle>
        <table className="w-full border-collapse border border-gray-400 text-center text-[11px]">
          <thead>
            <tr className="bg-gray-50 print:bg-gray-100">
              {disciplines.map((d) => (
                <th key={d} className="border border-gray-400 px-2 py-1">{disciplineLabel(d)}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            <tr>
              {disciplines.map((d) => (
                <td key={d} className="border border-gray-400 px-2 py-1">{engineerName(d)}</td>
              ))}
            </tr>
          </tbody>
        </table>
      </section>

      <section data-print-block="subcontract" className={blockCls("subcontract")}>
        <SectionTitle hidden={!isChecked("subcontract")}>發包單位</SectionTitle>
        <table className="w-full border-collapse border border-gray-400 text-center text-[11px]">
          <thead>
            <tr className="bg-gray-50 print:bg-gray-100">
              <th className="border border-gray-400 px-2 py-1">單位</th>
              <th className="border border-gray-400 px-2 py-1">聯絡</th>
              <th className="border border-gray-400 px-2 py-1">項目</th>
              <th className="border border-gray-400 px-2 py-1 text-right">金額</th>
              <th className="border border-gray-400 px-2 py-1">請款依據</th>
            </tr>
          </thead>
          <tbody>
            {subRows.map((row, i) => (
              <tr key={i}>
                <td className="border border-gray-400 px-2 py-1">{row?.vendorName || "—"}</td>
                <td className="border border-gray-400 px-2 py-1">{row?.contact || "—"}</td>
                <td className="border border-gray-400 px-2 py-1">{row?.item || "—"}</td>
                <td className="border border-gray-400 px-2 py-1 text-right">{row ? fmtMoney(row.amount) : "—"}</td>
                <td className="border border-gray-400 px-2 py-1">{row?.billingBasis || "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>

        {/* 發包小計／利潤：緊接在發包單位表格後面，版面上沒有獨立標題，資料也是由
            上面那張表衍生出來的財務摘要（毛利率），跟發包單位屬於同一份「不給客戶看」
            的資訊，勾掉發包單位時一併藏起來，不另外開一個 checkbox。 */}
        <table className="mt-3 w-full border-collapse border border-gray-400 text-center text-[11px]">
          <thead>
            <tr className="bg-gray-50 print:bg-gray-100">
              <th className="border border-gray-400 px-2 py-1">發包小計</th>
              <th className="border border-gray-400 px-2 py-1">其他支出</th>
              <th className="border border-gray-400 px-2 py-1">利潤</th>
              <th className="border border-gray-400 px-2 py-1">毛利率</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td className="border border-gray-400 px-2 py-1">{fmtMoney(money?.subcontractTotal)}</td>
              <td className="border border-gray-400 px-2 py-1">{fmtMoney(money?.otherExpenses)}</td>
              <td className="border border-gray-400 px-2 py-1">{fmtMoney(money?.profit)}</td>
              <td className="border border-gray-400 px-2 py-1">{money?.grossMarginPct ?? "—"}{money?.grossMarginPct != null && "%"}</td>
            </tr>
          </tbody>
        </table>
      </section>

      {/* M17：合約與印花稅。合約本體在專案明細頁維護，這裡只印摘要——
          老闆用這張申請單對帳時要看得到「這案簽了什麼、印花稅貼了沒」。 */}
      {contracts && (
        <section data-print-block="contracts" className={blockCls("contracts")}>
          <SectionTitle hidden={!isChecked("contracts")}>合約與印花稅</SectionTitle>
          {contracts.length === 0 ? (
            <p className="text-[11px] text-gray-500">尚無合約或報價單。</p>
          ) : (
            <table className="w-full border-collapse border border-gray-400 text-center text-[11px]">
              <thead>
                <tr className="bg-gray-50 print:bg-gray-100">
                  <th className="border border-gray-400 px-2 py-1">類型</th>
                  <th className="border border-gray-400 px-2 py-1">名稱</th>
                  <th className="border border-gray-400 px-2 py-1">對方</th>
                  <th className="border border-gray-400 px-2 py-1">我方角色</th>
                  <th className="border border-gray-400 px-2 py-1 text-right">金額</th>
                  <th className="border border-gray-400 px-2 py-1">簽訂日</th>
                  <th className="border border-gray-400 px-2 py-1">印花稅率</th>
                  <th className="border border-gray-400 px-2 py-1 text-right">印花稅額</th>
                  <th className="border border-gray-400 px-2 py-1">貼花</th>
                </tr>
              </thead>
              <tbody>
                {contracts.map((c) => (
                  <tr key={c.id}>
                    <td className="border border-gray-400 px-2 py-1">{DOC_TYPE_LABELS[c.docType]}</td>
                    <td className="border border-gray-400 px-2 py-1 text-left">{c.title || "—"}</td>
                    <td className="border border-gray-400 px-2 py-1">{c.counterparty || "—"}</td>
                    <td className="border border-gray-400 px-2 py-1">{OUR_ROLE_SHORT_LABELS[c.ourRole]}</td>
                    <td className="border border-gray-400 px-2 py-1 text-right">{fmtMoney(c.amount)}</td>
                    <td className="border border-gray-400 px-2 py-1">{c.signedOn ?? "—"}</td>
                    <td className="border border-gray-400 px-2 py-1">{c.dutiable ? formatDutyRate(c.stampDutyRate) : "不課"}</td>
                    <td className="border border-gray-400 px-2 py-1 text-right">{c.dutiable ? fmtMoney(c.stampDutyAmount) : "—"}</td>
                    <td className="border border-gray-400 px-2 py-1">
                      {!c.dutiable ? "—" : c.stampDutyPaidOn ? `已貼 ${c.stampDutyPaidOn}` : "未貼"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      )}
    </div>
  );
}

export default function ProjectApplicationPrintPage() {
  const params = useParams<{ id: string }>();
  const projectId = params.id;
  const [data, setData] = useState<ApplicationData | null>(null);
  /** M17：合約區塊的資料。合約讀不到（沒有 finance 權限）時留空陣列，區塊仍在但顯示「尚無合約」。 */
  const [contracts, setContracts] = useState<Contract[]>([]);
  /** 廠商名冊：協力技師的 vendorId → 名稱（GET /vendors 只要登入即可讀）；讀不到就留空，欄位退回只看 name。 */
  const [vendors, setVendors] = useState<Vendor[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [printChecked, setPrintChecked] = useState<Record<PrintBlockKey, boolean>>(defaultPrintChecked);
  // 是否已經讀過 localStorage 一次——下面「存檔＋同步 body class」的 effect 要等這個
  // 變 true 才准寫，見該 effect 前的說明。
  const [printCheckedHydrated, setPrintCheckedHydrated] = useState(false);

  useEffect(() => {
    let active = true;
    setLoading(true);
    getContracts(projectId)
      .then((res) => {
        if (active) setContracts(res.contracts);
      })
      .catch(() => {
        if (active) setContracts([]);
      });
    listVendors()
      .then((res) => {
        if (active) setVendors(res.vendors);
      })
      .catch(() => {
        if (active) setVendors([]);
      });
    getProjectApplication(projectId)
      .then((res) => {
        if (active) setData(res.application);
      })
      .catch((err) => {
        if (active) setError(err instanceof Error ? err.message : "載入失敗");
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [projectId]);

  // 讀取先前記住的列印區塊勾選狀態；故意放在掛載後的 effect 裡才讀 localStorage，
  // 不要在 useState 初始值直接讀，避免 SSR 產出的 HTML 跟掛載後的內容對不上。
  useEffect(() => {
    try {
      const raw = localStorage.getItem(PRINT_BLOCKS_STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as Partial<Record<PrintBlockKey, boolean>>;
        setPrintChecked((prev) => ({ ...prev, ...parsed }));
      }
    } catch {
      /* 壞資料忽略，維持預設全勾 */
    } finally {
      setPrintCheckedHydrated(true);
    }
  }, []);

  // 勾選狀態一變動：存回 localStorage，並同步到 <body> class 給 globals.css 的
  // @media print 判斷要不要印該區塊。離開頁面時要把這些 class 清掉——body 是
  // 跨頁共用的同一個 DOM node，不清的話會誤傷下一頁的列印。
  //
  // 這個 effect 一定要等上面那個「讀 localStorage」的 effect 跑完（hydrated
  // 變 true）才准寫：React 18 dev 模式的 StrictMode 會把掛載時的 effect 各多跑
  // 一次做重複呼叫檢查，兩個 effect 交錯執行時，這支若在讀取完成前就用預設值
  // （全勾）寫回 localStorage，會把使用者原本存的勾選狀態直接蓋掉、永遠救不回來
  // （已用 Playwright 實測重現過這個 race，不是假設）。
  useEffect(() => {
    if (!printCheckedHydrated) return;
    try {
      localStorage.setItem(PRINT_BLOCKS_STORAGE_KEY, JSON.stringify(printChecked));
    } catch {
      /* localStorage 不可用時略過，不影響畫面上的勾選行為 */
    }
    for (const { key } of PRINT_BLOCKS) {
      document.body.classList.toggle(`print-hide-${key}`, !printChecked[key]);
    }
    return () => {
      for (const { key } of PRINT_BLOCKS) {
        document.body.classList.remove(`print-hide-${key}`);
      }
    };
  }, [printChecked, printCheckedHydrated]);

  return (
    <div>
      <div className="no-print mb-4 flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={() => window.print()}
          className="rounded-md px-4 py-2 text-sm font-medium text-white"
          style={{ backgroundColor: "var(--brand)" }}
        >
          列印
        </button>
        <div className="ml-auto flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-gray-600">
          <span className="text-gray-400">列印區塊：</span>
          {PRINT_BLOCKS.map(({ key, label }) => (
            <label key={key} className="flex cursor-pointer select-none items-center gap-1">
              <input
                type="checkbox"
                className="h-3.5 w-3.5 rounded border-gray-300 accent-[var(--brand)]"
                checked={printChecked[key]}
                onChange={(e) =>
                  setPrintChecked((prev) => ({ ...prev, [key]: e.target.checked }))
                }
              />
              {label}
            </label>
          ))}
        </div>
      </div>
      {loading ? (
        <p className="text-sm text-gray-400">載入中…</p>
      ) : error || !data ? (
        <p className="text-sm text-red-600">{error ?? "找不到專案"}</p>
      ) : (
        <ApplicationDocument data={data} printChecked={printChecked} contracts={contracts} vendors={vendors} />
      )}
    </div>
  );
}
