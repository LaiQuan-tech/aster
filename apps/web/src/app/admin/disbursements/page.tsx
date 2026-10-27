"use client";

import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Card, Empty, ErrorText, Segmented, inputCls } from "@/components/admin-ui";
import { listVendors, type Vendor } from "@/lib/company-api";
import { defaultActiveCompanyId } from "@/lib/company-options";
import { getReceivables, listCompanies, type Company, type ReceivablesResponse } from "@/lib/projects-ext-api";
import { listProjects } from "@/lib/projects-api";
import DisbursementForm, { allocRowFromPayable, type DisbursementFormInitial, type ProjectOption } from "@/components/DisbursementForm";
import {
  createDisbursement,
  getDisbursementSummary,
  getPayables,
  humanizeDisbursementError,
  listDisbursements,
  DISBURSEMENT_METHOD_LABELS,
  type Disbursement,
  type DisbursementInput,
  type DisbursementSummary,
  type Payable,
} from "@/lib/disbursements-api";
import {
  BILLING_DISBURSEMENT_VIEWS,
  buildLedger,
  parseBillingDisbursementView,
  type BillingDisbursementView,
} from "@/lib/billing-disbursement";
import { getMeCached } from "@/lib/ess-state";
import type { ApiError } from "@/lib/api-client";
import LedgerView from "./_views/LedgerView";
import ReceivablesView from "./_views/ReceivablesView";
import PayablesView, { type PayableGroupView } from "./_views/PayablesView";
import RecordsView from "./_views/RecordsView";

function fmtMoney(n: number | null | undefined): string {
  return n == null ? "—" : n.toLocaleString();
}

/**
 * 請款與放款（2026-10-27 業主：「把請款與未收款跟放款融合，讓會計一目瞭然請款細節，並且打勾放款」）。
 * 原本兩個分頁——「請款與未收款」（/admin/projects/receivables）與「放款」（本頁）——合成一頁：
 *
 *   頁首統計（一份）：未收合計／逾期／應付未付／可放款／本月放款／本年放款／本年代扣
 *   關鍵字（一份）：對照、應收催收、應付建單共用
 *   子檢視（?view=）：
 *     ledger       請款 × 放款對照（預設）：每個專案客戶請款＋廠商付款，已核准的放款單打勾批次放款
 *     receivables  應收催收（原「請款與未收款」整頁；舊網址轉到這裡）
 *     payables     應付建單（原「應付清單」：勾期款建立放款單）
 *     records      放款紀錄（原「匯款紀錄」：篩選／匯出／已付但無匯款單／新增匯款／送簽）
 *   待簽核、年度總覽仍是子分頁（/admin/disbursements/approvals、/pivot），放款單明細仍在 /admin/disbursements/[id]。
 */
function BillingDisbursementsPage() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const view = parseBillingDisbursementView(searchParams.get("view"));
  const setView = useCallback(
    (next: BillingDisbursementView) => {
      const params = new URLSearchParams(searchParams.toString());
      if (next === "ledger") params.delete("view");
      else params.set("view", next);
      const qs = params.toString();
      router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
    },
    [router, pathname, searchParams],
  );

  const [q, setQ] = useState("");
  const [scope, setScope] = useState<"open" | "all">("open");

  const [summary, setSummary] = useState<DisbursementSummary | null>(null);
  const [vendors, setVendors] = useState<Vendor[]>([]);
  const [companies, setCompanies] = useState<Company[]>([]);
  const [projects, setProjects] = useState<ProjectOption[]>([]);
  const [payables, setPayables] = useState<Payable[]>([]);
  const [acceptanceTracked, setAcceptanceTracked] = useState(false);
  const [today, setToday] = useState("");
  const [disbursements, setDisbursements] = useState<Disbursement[]>([]);
  const [openReceivables, setOpenReceivables] = useState<ReceivablesResponse | null>(null);
  const [allReceivables, setAllReceivables] = useState<ReceivablesResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  const [formOpen, setFormOpen] = useState(false);
  const [formInitial, setFormInitial] = useState<DisbursementFormInitial | undefined>(undefined);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  /** M5：上一次建單被 409 acceptance_required 擋下 → 表單顯示期別提示與 HR 強制選項。 */
  const [acceptanceBlocked, setAcceptanceBlocked] = useState(false);
  const [isHr, setIsHr] = useState(false);

  const loadBase = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [s, v, c, p, pay, list, rec] = await Promise.all([
        getDisbursementSummary(),
        listVendors(),
        listCompanies(),
        listProjects(),
        getPayables(),
        listDisbursements(),
        getReceivables("open"),
      ]);
      setSummary(s);
      setVendors(v.vendors);
      setCompanies(c.companies);
      setProjects(p.projects.map((x) => ({ id: x.id, code: x.code, name: x.name })));
      setPayables(pay.payables);
      setAcceptanceTracked(pay.acceptanceTracked === true);
      setToday(pay.today);
      setDisbursements(list.disbursements);
      setOpenReceivables(rec);
      setAllReceivables(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "載入失敗");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadBase();
  }, [loadBase]);

  // 「全部」模式才另抓已收完的請款期別（只抓一次，重新整理時清掉）。
  useEffect(() => {
    if (scope !== "all" || allReceivables) return;
    void getReceivables("all")
      .then(setAllReceivables)
      .catch((err) => setError(err instanceof Error ? err.message : "載入失敗"));
  }, [scope, allReceivables]);

  useEffect(() => {
    void (async () => {
      try {
        const me = await getMeCached();
        setIsHr(me.role === "hr_admin" || me.role === "platform_admin");
      } catch {
        /* 取不到就當非 HR，少一個強制放行選項 */
      }
    })();
  }, []);

  const payablesAcceptance = useMemo(
    () => new Map(payables.map((p) => [p.subcontractPaymentId, { acceptedOn: p.acceptedOn, installmentNo: p.installmentNo }])),
    [payables],
  );
  const activeDisbursements = useMemo(
    () => disbursements.filter((d) => d.status === "draft" || d.status === "pending_approval" || d.status === "approved"),
    [disbursements],
  );

  const ledgerReceivables = scope === "all" ? allReceivables : openReceivables;
  const ledger = useMemo(
    () =>
      buildLedger({
        receivables: ledgerReceivables?.receivables ?? [],
        payables,
        disbursements,
        acceptanceTracked,
        includePaid: scope === "all",
      }),
    [ledgerReceivables, payables, disbursements, acceptanceTracked, scope],
  );

  /** 可放款＝全租戶「已核准、期款都已驗收」的放款單（不受關鍵字影響）。 */
  const readyToPay = useMemo(() => {
    const ids = new Map<string, number>();
    for (const p of buildLedger({ receivables: [], payables, disbursements: activeDisbursements, acceptanceTracked, includePaid: false })) {
      for (const v of p.vendorRows) if (v.state === "ready_to_pay" && v.disbursement) ids.set(v.disbursement.id, v.disbursement.amount);
    }
    return { count: ids.size, total: [...ids.values()].reduce((s, n) => s + n, 0) };
  }, [payables, activeDisbursements, acceptanceTracked]);

  const reloadAll = useCallback(async () => {
    setReloadKey((k) => k + 1);
    await loadBase();
  }, [loadBase]);

  function openCreateFromGroup(group: PayableGroupView, chosen: Payable[]) {
    const vendor = group.vendorId ? vendors.find((v) => v.id === group.vendorId) : undefined;
    // 新放款單的付款公司預設選啟用的預設公司（已停用的公司不會被當預設）。
    const defaultCompanyId = defaultActiveCompanyId(companies);
    setFormInitial({
      // 沒有 vendorId（名冊沒建檔的廠商）就不能存成 payeeKind:'vendor'（後端會回
      // invalid_vendor），改預設「其他」，逼使用者在表單裡自己選一個真廠商或確認用其他收款方。
      payeeKind: group.vendorId ? "vendor" : "other",
      vendorId: group.vendorId,
      payeeName: group.vendorName,
      payeeBankName: vendor?.bankName ?? null,
      payeeBankAccount: vendor?.bankAccount ?? null,
      payingCompanyId: defaultCompanyId || null,
      amount: chosen.reduce((s, r) => s + r.netAmount, 0),
      withheldAmount: chosen.reduce((s, r) => s + r.withheldAmount, 0),
      allocations: chosen.map(allocRowFromPayable),
      status: "draft",
    });
    setSaveError(null);
    setAcceptanceBlocked(false);
    setFormOpen(true);
  }

  function openCreateBlank() {
    setFormInitial({ payeeKind: "vendor", payingCompanyId: defaultActiveCompanyId(companies) || null, status: "draft", allocations: [] });
    setSaveError(null);
    setAcceptanceBlocked(false);
    setFormOpen(true);
  }

  async function handleCreate(body: DisbursementInput) {
    setSaving(true);
    setSaveError(null);
    try {
      await createDisbursement(body);
      setFormOpen(false);
      setFormInitial(undefined);
      setAcceptanceBlocked(false);
      await reloadAll();
      setView("records");
    } catch (err) {
      setAcceptanceBlocked((err as ApiError)?.code === "acceptance_required");
      setSaveError(humanizeDisbursementError(err, "建立失敗"));
    } finally {
      setSaving(false);
    }
  }

  const unreceived = openReceivables?.summary;

  return (
    <>
      <Card>
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-4 lg:grid-cols-7">
          <Stat label="未收合計" value={fmtMoney(unreceived?.unreceivedTotal)} tone="text-red-600" hint={unreceived ? `${unreceived.count} 期` : undefined} />
          <Stat label="逾期" value={unreceived ? `${unreceived.overdueCount} 期` : "—"} tone="text-amber-600" />
          <Stat label="應付未付" value={fmtMoney(summary?.unpaidPayableTotal)} tone="text-amber-600" />
          <Stat label="可放款（已核准）" value={fmtMoney(readyToPay.total)} tone="text-emerald-700" hint={`${readyToPay.count} 張`} />
          <Stat label="本月放款" value={fmtMoney(summary?.monthTotal)} />
          <Stat label="本年放款" value={fmtMoney(summary?.yearTotal)} />
          <Stat label="本年代扣" value={fmtMoney(summary?.yearWithheldTotal)} tone="text-gray-700" />
        </div>
      </Card>

      <ErrorText>{error}</ErrorText>

      <Card>
        <div className="flex flex-wrap items-center gap-3">
          <Segmented
            options={BILLING_DISBURSEMENT_VIEWS.map((v) => ({ value: v.value, label: v.label }))}
            value={view}
            onChange={setView}
            className="w-full md:w-auto"
            aria-label="請款與放款檢視切換"
          />
          <div className="grow" />
          {view !== "records" && (
            <input
              className={`${inputCls} md:w-72`}
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="關鍵字：專案編號／名稱／客戶／廠商／放款單號"
              aria-label="關鍵字"
            />
          )}
        </div>
      </Card>

      {view === "ledger" &&
        (loading && !summary ? (
          <Card>
            <Empty>載入中…</Empty>
          </Card>
        ) : (
          <LedgerView
            ledger={ledger}
            disbursements={disbursements}
            payablesAcceptance={payablesAcceptance}
            acceptanceTracked={acceptanceTracked}
            today={today}
            loading={loading || (scope === "all" && !allReceivables)}
            q={q}
            scope={scope}
            onScopeChange={setScope}
            onPaid={reloadAll}
          />
        ))}
      {view === "receivables" && <ReceivablesView q={q} />}
      {view === "payables" && (
        <PayablesView
          payables={payables}
          activeDisbursements={activeDisbursements}
          acceptanceTracked={acceptanceTracked}
          loading={loading}
          q={q}
          onCreateFromGroup={openCreateFromGroup}
        />
      )}
      {view === "records" && (
        <RecordsView vendors={vendors} companies={companies} projects={projects} reloadKey={reloadKey} onCreateBlank={openCreateBlank} />
      )}

      {formOpen && (
        <Card>
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-sm font-semibold text-gray-700">新增匯款</h2>
            <span className="text-xs text-gray-400">方式：{Object.values(DISBURSEMENT_METHOD_LABELS).join(" / ")}</span>
          </div>
          <DisbursementForm
            vendors={vendors}
            companies={companies}
            projects={projects}
            payables={payables}
            initial={formInitial}
            acceptanceBlocked={acceptanceBlocked}
            canForceAcceptance={isHr}
            submitLabel="建立匯款"
            busy={saving}
            error={saveError}
            onSubmit={handleCreate}
            onCancel={() => {
              setFormOpen(false);
              setFormInitial(undefined);
              setAcceptanceBlocked(false);
            }}
          />
        </Card>
      )}
    </>
  );
}

function Stat({ label, value, tone = "text-gray-900", hint }: { label: string; value: string; tone?: string; hint?: string }) {
  return (
    <div>
      <p className="text-xs text-gray-500">{label}</p>
      <p className={`text-xl font-semibold tabular-nums ${tone}`}>{value}</p>
      {hint && <p className="text-[11px] text-gray-400">{hint}</p>}
    </div>
  );
}

export default function Page() {
  return (
    <Suspense
      fallback={
        <Card>
          <Empty>載入中…</Empty>
        </Card>
      }
    >
      <BillingDisbursementsPage />
    </Suspense>
  );
}
