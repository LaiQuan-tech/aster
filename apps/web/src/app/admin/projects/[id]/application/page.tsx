"use client";

import { sheet } from "@/lib/sheet-styles";
import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { listVendors, type Vendor } from "@/lib/company-api";
import { DOC_TYPE_LABELS, OUR_ROLE_SHORT_LABELS, getContracts, type Contract } from "@/lib/projects-api";
import {
  getProjectApplication,
  engineerDisciplinesOf,
  type ApplicationData,
  type ProjectDetail,
} from "@/lib/projects-ext-api";
import { PRINT_BLOCKS, type PrintBlockKey } from "@/lib/project-application-sheet";
import { ApplicationSheet } from "../_sections/ApplicationSheet";

/*
 * 列印區塊（B6）的 key／標籤由 lib/project-application-sheet.ts 提供（專案明細頁的申請單表格共用同一份）。
 * 新版面是一張固定格線的表：取消勾選＝那一區的內容格列印留白、標題與框線照印（不能整塊抽掉，
 * 會在格線裡留下空洞）；合約與印花稅表整張不印（與舊版相同）。
 */

const PRINT_BLOCKS_STORAGE_KEY = "print-blocks:project-application";

function defaultPrintChecked(): Record<PrintBlockKey, boolean> {
  const result = {} as Record<PrintBlockKey, boolean>;
  for (const { key } of PRINT_BLOCKS) result[key] = true;
  return result;
}

/** 印花稅率以千分率呈現（承攬契據法定 1‰＝rate 0.001）；沒有費率回破折號。 */
function formatDutyRate(rate: number | null | undefined): string {
  if (rate == null) return "—";
  const permille = rate * 1000;
  return `${Number.isInteger(permille) ? permille : permille.toFixed(2)}‰`;
}

function fmtMoney(n: number | null | undefined): string {
  return n == null ? "—" : n.toLocaleString();
}

/**
 * 列印版申請單：與專案明細頁同一個 ApplicationSheet（print 模式，唯讀、A4 直式），下方接合約與印花稅摘要。
 * 純呈現元件——不打 API，資料整包用 props 傳入（截圖驗收可直接餵假資料）。
 */
export function ApplicationDocument({
  data,
  printChecked,
  contracts,
  vendors,
  showProfit = true,
  canFinance = true,
}: {
  data: ApplicationData;
  printChecked?: Partial<Record<PrintBlockKey, boolean>>;
  /** M17：合約與印花稅區塊的資料（也是「訂單」格的來源）；省略＝不畫合約表。 */
  contracts?: Contract[];
  /** 廠商名冊：協力技師只存 vendorId 時靠它對回名稱。 */
  vendors?: Vendor[];
  /** 利潤／毛利率（access.profit，屬集團財務）。false＝格子留著但不顯示數字。 */
  showProfit?: boolean;
  /** 看得到錢（access.finance）：false 時銷售金額等格顯示「—」（後端本來也不回）。 */
  canFinance?: boolean;
}) {
  const contractsOn = printChecked?.contracts ?? true;
  // /application 的 project 段不含 client（另外平行給），補回去就是明細頁同一份資料形狀。
  const project = { ...data.project, client: data.client, openedOn: data.openedOn } as ProjectDetail;
  return (
    <div className="print-sheet mx-auto max-w-[1000px] print:max-w-none">
      <ApplicationSheet
        mode="print"
        project={project}
        canFinance={canFinance}
        showProfit={showProfit}
        money={data.money}
        billings={data.billings}
        subcontracts={data.subcontracts}
        contracts={contracts ?? []}
        companies={[]}
        vendors={vendors ?? []}
        disciplines={engineerDisciplinesOf(data.settings?.disciplines)}
        printChecked={printChecked}
        latestDocument={data.latestDocument}
      />

      {/* M17：合約與印花稅。合約本體在專案明細頁維護，這裡只印摘要。 */}
      {contracts && (
        <section className={`mt-4 rounded-2xl border border-gray-200 bg-white p-3 sm:p-5 print:mt-3 print:rounded-none print:border-0 print:p-0 ${contractsOn ? "" : "no-print opacity-40"}`} data-testid="application-contracts">
          <h2 className={`mb-2 flex items-center gap-2 ${sheet.title}`}>
            合約與印花稅
            {!contractsOn && <span className="no-print rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-normal text-amber-700">列印時不印</span>}
          </h2>
          {contracts.length === 0 ? (
            <p className="text-sm text-gray-500">尚無合約或報價單。</p>
          ) : (
            <div className={`${sheet.frame} print:overflow-visible`}>
              <table className={`${sheet.table} text-center`}>
                <thead>
                  <tr>
                    <th className={sheet.th}>類型</th>
                    <th className={sheet.th}>名稱</th>
                    <th className={sheet.th}>對方</th>
                    <th className={sheet.th}>我方角色</th>
                    <th className={`${sheet.th} !text-right`}>金額</th>
                    <th className={sheet.th}>簽訂日</th>
                    <th className={sheet.th}>印花稅率</th>
                    <th className={`${sheet.th} !text-right`}>印花稅額</th>
                    <th className={sheet.th}>貼花</th>
                  </tr>
                </thead>
                <tbody>
                  {contracts.map((c) => (
                    <tr key={c.id} className={sheet.row}>
                      <td className={sheet.td}>{DOC_TYPE_LABELS[c.docType]}</td>
                      <td className={`${sheet.td} text-left`}>{c.title || "—"}</td>
                      <td className={sheet.td}>{c.counterparty || "—"}</td>
                      <td className={sheet.td}>{OUR_ROLE_SHORT_LABELS[c.ourRole]}</td>
                      <td className={`${sheet.td} ${sheet.num}`}>{fmtMoney(c.amount)}</td>
                      <td className={sheet.td}>{c.signedOn ?? "—"}</td>
                      <td className={sheet.td}>{c.dutiable ? formatDutyRate(c.stampDutyRate) : "不課"}</td>
                      <td className={`${sheet.td} ${sheet.num}`}>{c.dutiable ? fmtMoney(c.stampDutyAmount) : "—"}</td>
                      <td className={sheet.td}>
                        {!c.dutiable ? "—" : c.stampDutyPaidOn ? `已貼 ${c.stampDutyPaidOn}` : "未貼"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
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
  // 利潤／毛利率只給看得到集團財務的人（access.profit；舊後端沒有＝照舊顯示）。
  const [showProfit, setShowProfit] = useState(true);
  const [canFinance, setCanFinance] = useState(true);
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
        if (active) {
          setData(res.application);
          setShowProfit(res.access.profit !== false);
          setCanFinance(res.access.finance);
        }
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

  // 勾選狀態一變動：存回 localStorage（列印留白由 ApplicationSheet 依 printChecked 自己處理，不再靠 <body> class）。
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
          <span className="text-gray-400" title="取消勾選的區塊：畫面淡化，列印時內容留白（表格標題與框線照印）；合約與印花稅整張不印">列印區塊：</span>
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
        <p className="w-full text-right text-[11px] text-gray-400">
          取消勾選的區塊：畫面淡化，列印時內容留白（表格標題與框線照印）；合約與印花稅整張不印。
        </p>
      </div>
      {loading ? (
        <p className="text-sm text-gray-400">載入中…</p>
      ) : error || !data ? (
        <p className="text-sm text-red-600">{error ?? "找不到專案"}</p>
      ) : (
        <ApplicationDocument data={data} printChecked={printChecked} contracts={contracts} vendors={vendors} showProfit={showProfit} canFinance={canFinance} />
      )}
    </div>
  );
}
