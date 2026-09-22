"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Card, Empty, ErrorText, PrimaryButton, Segmented } from "@/components/admin-ui";
import { getMe } from "@/lib/admin-api";
import {
  approveDisbursement,
  getPendingDisbursementApprovals,
  humanizeDisbursementError,
  rejectDisbursement,
  DISBURSEMENT_STEP_KIND_LABELS,
  type PendingDisbursementApproval,
} from "@/lib/disbursements-api";

function fmtMoney(n: number | null | undefined): string {
  return n == null ? "—" : n.toLocaleString();
}
function fmtWhen(iso: string | null | undefined): string {
  return iso ? iso.slice(0, 16).replace("T", " ") : "—";
}

type Scope = "mine" | "all";

/**
 * M4 放款簽核：後台版「待簽核清單」。
 *   輪到我簽   ＝ GET /disbursements/pending-approvals（任何員工都能打，看得到什麼由關卡候選決定）
 *   全部送簽中 ＝ 同一支帶 scope=all（限 finance 角色；HR／會計用來看整條隊伍卡在哪一關）
 * 每列可以直接核准／駁回（駁回理由必填，整張單退回草稿並通知建單人）；
 * 手機上的簽核在 /ess/approvals，兩邊打同一組端點。
 */
export default function DisbursementApprovalsPage() {
  const [scope, setScope] = useState<Scope>("mine");
  const [rows, setRows] = useState<PendingDisbursementApproval[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [canSeeAll, setCanSeeAll] = useState(false);
  const [comment, setComment] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await getPendingDisbursementApprovals({ scope });
      setRows(res.disbursements);
    } catch (err) {
      setError(humanizeDisbursementError(err, "載入失敗"));
    } finally {
      setLoading(false);
    }
  }, [scope]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    void (async () => {
      try {
        const me = await getMe();
        setCanSeeAll(me.role === "hr_admin" || me.role === "platform_admin" || me.role === "accountant");
      } catch {
        /* 取不到就只給「輪到我簽」 */
      }
    })();
  }, []);

  async function onApprove(row: PendingDisbursementApproval) {
    setBusyId(row.id);
    setError(null);
    setMsg(null);
    try {
      const res = await approveDisbursement(row.id, comment[row.id]?.trim() || undefined);
      setMsg(
        res.status === "approved"
          ? `${row.disbursementNo} 已完成全部簽核，可以付款了。`
          : `${row.disbursementNo} 已送往第 ${res.currentStep} 關。`,
      );
      setComment((c) => ({ ...c, [row.id]: "" }));
      await load();
    } catch (err) {
      setError(humanizeDisbursementError(err, "核准失敗"));
    } finally {
      setBusyId(null);
    }
  }

  async function onReject(row: PendingDisbursementApproval) {
    const reason = (comment[row.id] ?? "").trim() || window.prompt("駁回理由？（建單人會在通知裡看到）")?.trim();
    if (!reason) {
      setError("駁回必須填理由。");
      return;
    }
    setBusyId(row.id);
    setError(null);
    setMsg(null);
    try {
      await rejectDisbursement(row.id, reason);
      setMsg(`${row.disbursementNo} 已駁回，退回草稿並通知建單人。`);
      setComment((c) => ({ ...c, [row.id]: "" }));
      await load();
    } catch (err) {
      setError(humanizeDisbursementError(err, "駁回失敗"));
    } finally {
      setBusyId(null);
    }
  }

  return (
    <>
      <Card>
        <div className="flex flex-wrap items-center gap-2">
          <Segmented
            options={[
              { value: "mine", label: "輪到我簽" },
              ...(canSeeAll ? [{ value: "all" as const, label: "全部送簽中" }] : []),
            ]}
            value={scope}
            onChange={(v) => setScope(v as Scope)}
            className="w-full md:w-auto"
            aria-label="放款簽核檢視切換"
          />
          <div className="grow" />
          <span className="text-xs text-gray-400">{loading ? "載入中…" : `${rows.length} 張`}</span>
        </div>
      </Card>

      <ErrorText>{error}</ErrorText>
      {msg && <p className="rounded-md bg-emerald-50 px-3 py-2 text-sm text-emerald-700">{msg}</p>}

      <Card>
        {loading ? (
          <Empty>載入中…</Empty>
        ) : rows.length === 0 ? (
          <Empty>{scope === "mine" ? "目前沒有輪到你簽的放款單" : "目前沒有送簽中的放款單"}</Empty>
        ) : (
          <div className="space-y-4">
            {rows.map((d) => (
              <div key={d.id} className="border-b pb-4 last:border-0 last:pb-0">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <div className="min-w-0">
                    <Link href={`/admin/disbursements/${d.id}`} className="font-mono text-sm hover:underline" style={{ color: "var(--brand)" }}>
                      {d.disbursementNo}
                    </Link>
                    <span className="ml-2 text-sm font-medium text-gray-900">{d.payeeName}</span>
                    <span className="ml-2 text-sm text-gray-600">實付 {fmtMoney(d.amount)}</span>
                    {d.withheldAmount > 0 && <span className="ml-1 text-xs text-gray-400">（代扣 {fmtMoney(d.withheldAmount)}）</span>}
                  </div>
                  <span className="rounded-full bg-blue-50 px-2 py-0.5 text-xs text-blue-700">
                    第 {d.currentStepOrder}／{d.totalSteps} 關
                    {d.stepKindLabel ? ` · ${d.stepKindLabel}` : d.stepKind ? ` · ${DISBURSEMENT_STEP_KIND_LABELS[d.stepKind] ?? d.stepKind}` : ""}
                  </span>
                </div>
                <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-sm text-gray-600 sm:grid-cols-4">
                  <div>
                    <dt className="text-xs text-gray-400">付款公司</dt>
                    <dd>{d.payingCompanyName ?? "—"}</dd>
                  </div>
                  <div>
                    <dt className="text-xs text-gray-400">分攤專案</dt>
                    <dd>{d.allocationLabel || "—"}</dd>
                  </div>
                  <div>
                    <dt className="text-xs text-gray-400">用途</dt>
                    <dd>{d.purpose ?? "—"}</dd>
                  </div>
                  <div>
                    <dt className="text-xs text-gray-400">建單／送簽</dt>
                    <dd>
                      {d.createdByName ?? "—"} · {fmtWhen(d.submittedAt)}
                    </dd>
                  </div>
                </dl>
                {d.candidateNames.length > 0 && (
                  <p className="mt-1 text-xs text-gray-400">本關可簽：{d.candidateNames.join("、")}</p>
                )}
                {d.mine ? (
                  <div className="mt-3 flex flex-wrap items-center gap-2">
                    <input
                      className="min-w-[14rem] grow rounded border border-gray-300 px-2 py-1.5 text-sm"
                      value={comment[d.id] ?? ""}
                      onChange={(e) => setComment((c) => ({ ...c, [d.id]: e.target.value }))}
                      placeholder="簽核意見（核准選填、駁回必填）"
                      maxLength={250}
                    />
                    <PrimaryButton onClick={() => void onApprove(d)} disabled={busyId === d.id}>
                      {busyId === d.id ? "處理中…" : "核准"}
                    </PrimaryButton>
                    <button
                      type="button"
                      onClick={() => void onReject(d)}
                      disabled={busyId === d.id}
                      className="rounded-md border border-red-200 px-3 py-2 text-sm text-red-600 hover:bg-red-50 disabled:opacity-50"
                    >
                      駁回
                    </button>
                  </div>
                ) : (
                  <p className="mt-2 text-xs text-gray-400">等待上列簽核人處理（你不是這一關的候選）。</p>
                )}
              </div>
            ))}
          </div>
        )}
      </Card>
    </>
  );
}
