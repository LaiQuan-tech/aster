"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { DOC_TYPE_LABELS } from "@/lib/projects-api";
import {
  getProjectApplication,
  formatRocDate,
  INVOICE_TYPE_LABELS,
  PAYMENT_METHOD_LABELS,
  ENGINEER_DISCIPLINE_LABELS,
  ENGINEER_DISCIPLINES,
  BILLING_KIND_LABELS,
  type ApplicationData,
  type BillingExt,
  type Subcontract,
} from "@/lib/projects-ext-api";

function fmtMoney(n: number | null | undefined): string {
  return n == null ? "—" : n.toLocaleString();
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

/**
 * 純呈現元件——不打 API，資料整包用 props 傳入。刻意抽出來是為了讓暫時的
 * 假資料預覽頁（截圖驗收用）跟正式頁共用同一份排版，驗完就能把暫時頁刪掉，
 * 排版本身留在這裡不受影響。
 */
export function ApplicationDocument({ data }: { data: ApplicationData }) {
  const { project, client, latestDocument, designScope, engineers, billings, subcontracts, money } = data;

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

      <h2 className="mb-1 mt-3 text-xs font-semibold text-gray-700">客戶資料</h2>
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

      <h2 className="mb-1 mt-3 text-xs font-semibold text-gray-700">銷售金額</h2>
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

      <h2 className="mb-1 mt-3 text-xs font-semibold text-gray-700">付款階段</h2>
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

      <h2 className="mb-1 mt-3 text-xs font-semibold text-gray-700">協力技師</h2>
      <table className="w-full border-collapse border border-gray-400 text-center text-[11px]">
        <thead>
          <tr className="bg-gray-50 print:bg-gray-100">
            {ENGINEER_DISCIPLINES.map((d) => (
              <th key={d} className="border border-gray-400 px-2 py-1">{ENGINEER_DISCIPLINE_LABELS[d]}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          <tr>
            {ENGINEER_DISCIPLINES.map((d) => (
              <td key={d} className="border border-gray-400 px-2 py-1">{engineers?.[d]?.name || "—"}</td>
            ))}
          </tr>
        </tbody>
      </table>

      <h2 className="mb-1 mt-3 text-xs font-semibold text-gray-700">發包單位</h2>
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
    </div>
  );
}

export default function ProjectApplicationPrintPage() {
  const params = useParams<{ id: string }>();
  const projectId = params.id;
  const [data, setData] = useState<ApplicationData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    setLoading(true);
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

  return (
    <div>
      <div className="no-print mb-4 flex items-center gap-3">
        <button
          type="button"
          onClick={() => window.print()}
          className="rounded-md px-4 py-2 text-sm font-medium text-white"
          style={{ backgroundColor: "var(--brand)" }}
        >
          列印
        </button>
        <Link href={`/admin/projects/${projectId}`} className="text-sm text-gray-500 hover:underline">
          ← 返回專案
        </Link>
      </div>
      {loading ? (
        <p className="text-sm text-gray-400">載入中…</p>
      ) : error || !data ? (
        <p className="text-sm text-red-600">{error ?? "找不到專案"}</p>
      ) : (
        <ApplicationDocument data={data} />
      )}
    </div>
  );
}
