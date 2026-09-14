"use client";

import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { Card, PageHeader, PrimaryButton, ErrorText, Empty, inputCls, labelCls } from "@/components/admin-ui";
import {
  getLeaveTypes,
  createLeaveType,
  updateLeaveType,
  deleteLeaveType,
  getApprovalFlows,
  setApprovalFlow,
  getEmployees,
  type LeaveType,
  type ApprovalFlow,
  type Employee,
  type RequestKind,
} from "@/lib/admin-api";

const KINDS: { kind: RequestKind; label: string }[] = [
  { kind: "leave", label: "請假" },
  { kind: "ot", label: "加班" },
  { kind: "fix_punch", label: "補卡" },
  { kind: "business_trip", label: "公出/出差" },
];

/** 扣薪比例顯示用：deduct_rate 為 null 時依 paid 推算（有薪 0、無薪 1），與 DB 欄位註解一致。 */
function effectiveDeductRate(lt: Pick<LeaveType, "deduct_rate" | "paid">): number {
  if (lt.deduct_rate !== null && lt.deduct_rate !== undefined && lt.deduct_rate !== "") {
    const n = Number(lt.deduct_rate);
    if (Number.isFinite(n)) return n;
  }
  return lt.paid ? 0 : 1;
}

export default function LeaveTypesPage() {
  const [types, setTypes] = useState<LeaveType[]>([]);
  const [flows, setFlows] = useState<ApprovalFlow[]>([]);
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // create leave type
  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  const [paid, setPaid] = useState(true);
  const [special, setSpecial] = useState(false);
  const [deductRate, setDeductRate] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  // edit leave type
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [editPaid, setEditPaid] = useState(true);
  const [editSpecial, setEditSpecial] = useState(false);
  const [editDeductRate, setEditDeductRate] = useState("");

  // approval flows: kind -> selected approver emp ids (ordered by employee list)
  const [flowDraft, setFlowDraft] = useState<Record<string, string[]>>({});
  const [flowMsg, setFlowMsg] = useState<string | null>(null);

  const empName = useMemo(() => {
    const m = new Map<string, string>();
    for (const e of employees) m.set(e.id, e.name);
    return m;
  }, [employees]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [ltRes, flowRes, empRes] = await Promise.all([
        getLeaveTypes(),
        getApprovalFlows(),
        getEmployees(),
      ]);
      setTypes(ltRes.leaveTypes);
      setFlows(flowRes.flows);
      setEmployees(empRes.employees);
      const draft: Record<string, string[]> = {};
      for (const f of flowRes.flows) draft[f.applies_to] = f.approver_emp_ids ?? [];
      setFlowDraft(draft);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "載入失敗");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function onCreate(e: FormEvent) {
    e.preventDefault();
    setFormError(null);
    if (!code.trim() || !name.trim()) {
      setFormError("請輸入代碼與名稱");
      return;
    }
    setSubmitting(true);
    try {
      await createLeaveType({
        code: code.trim(),
        name: name.trim(),
        paid,
        special,
        deductRate: deductRate.trim() === "" ? null : Number(deductRate),
      });
      setCode("");
      setName("");
      setPaid(true);
      setSpecial(false);
      setDeductRate("");
      await load();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : "新增失敗（代碼可能重複）");
    } finally {
      setSubmitting(false);
    }
  }

  async function saveEdit(id: string) {
    if (!editName.trim()) return;
    try {
      await updateLeaveType(id, {
        name: editName.trim(),
        paid: editPaid,
        special: editSpecial,
        deductRate: editDeductRate.trim() === "" ? null : Number(editDeductRate),
      });
      setEditingId(null);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "更新失敗");
    }
  }

  async function onDelete(id: string) {
    if (!confirm("確定刪除此假別？")) return;
    try {
      await deleteLeaveType(id);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "刪除失敗");
    }
  }

  function toggleApprover(kind: RequestKind, empId: string) {
    setFlowDraft((prev) => {
      const cur = prev[kind] ?? [];
      const next = cur.includes(empId) ? cur.filter((x) => x !== empId) : [...cur, empId];
      return { ...prev, [kind]: next };
    });
  }

  async function saveFlow(kind: RequestKind) {
    setFlowMsg(null);
    try {
      await setApprovalFlow(kind, flowDraft[kind] ?? []);
      setFlowMsg(`${KINDS.find((k) => k.kind === kind)?.label} 簽核流程已儲存`);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "儲存簽核流程失敗");
    }
  }

  return (
    <>
      <PageHeader title="假別與簽核流程" desc="維護假別並設定各申請類別的簽核者" />

      {/* Leave types */}
      <Card>
        <h2 className="mb-4 text-sm font-medium text-gray-500">新增假別</h2>
        <form onSubmit={onCreate} className="space-y-4">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-4">
            <div>
              <label className={labelCls}>代碼</label>
              <input className={inputCls} value={code} onChange={(e) => setCode(e.target.value)} placeholder="annual" />
            </div>
            <div>
              <label className={labelCls}>名稱</label>
              <input className={inputCls} value={name} onChange={(e) => setName(e.target.value)} placeholder="特休" />
            </div>
            <div>
              <label className={labelCls}>扣薪比例（0～1）</label>
              <input
                type="number"
                min={0}
                max={1}
                step={0.5}
                className={inputCls}
                value={deductRate}
                onChange={(e) => setDeductRate(e.target.value)}
                placeholder={paid ? "留空＝0（有薪）" : "留空＝1（無薪）"}
              />
              <p className="mt-1 text-xs text-gray-400">留空＝依「支薪」推算：支薪 0、不支薪 1</p>
            </div>
            <div className="flex items-end gap-4">
              <label className="flex items-center gap-2 pb-2 text-sm text-gray-700">
                <input type="checkbox" checked={paid} onChange={(e) => setPaid(e.target.checked)} />
                支薪
              </label>
              <label className="flex items-center gap-2 pb-2 text-sm text-gray-700">
                <input type="checkbox" checked={special} onChange={(e) => setSpecial(e.target.checked)} />
                特殊假別
              </label>
            </div>
          </div>
          {formError && <ErrorText>{formError}</ErrorText>}
          <PrimaryButton type="submit" disabled={submitting}>
            {submitting ? "新增中…" : "新增假別"}
          </PrimaryButton>
        </form>
      </Card>

      <Card>
        <h2 className="mb-4 text-sm font-medium text-gray-500">假別列表</h2>
        {error && <div className="mb-3"><ErrorText>{error}</ErrorText></div>}
        {loading ? (
          <Empty>載入中…</Empty>
        ) : types.length === 0 ? (
          <Empty>尚無假別</Empty>
        ) : (
          <ul className="divide-y divide-gray-100">
            {types.map((lt) => (
              <li key={lt.id} className="flex items-center justify-between gap-3 py-3">
                {editingId === lt.id ? (
                  <>
                    <div className="flex flex-1 flex-wrap items-center gap-3">
                      <input
                        className={inputCls}
                        value={editName}
                        onChange={(e) => setEditName(e.target.value)}
                      />
                      <label className="flex shrink-0 items-center gap-1 text-sm text-gray-700">
                        扣薪
                        <input
                          type="number"
                          min={0}
                          max={1}
                          step={0.5}
                          value={editDeductRate}
                          onChange={(e) => setEditDeductRate(e.target.value)}
                          placeholder={editPaid ? "0" : "1"}
                          className="w-16 rounded-md border border-gray-300 px-2 py-1 text-sm"
                          title="扣薪比例（0～1），留空＝依支薪推算"
                        />
                      </label>
                      <label className="flex shrink-0 items-center gap-1 text-sm text-gray-700">
                        <input
                          type="checkbox"
                          checked={editPaid}
                          onChange={(e) => setEditPaid(e.target.checked)}
                        />
                        支薪
                      </label>
                      <label className="flex shrink-0 items-center gap-1 text-sm text-gray-700">
                        <input
                          type="checkbox"
                          checked={editSpecial}
                          onChange={(e) => setEditSpecial(e.target.checked)}
                        />
                        特殊假別
                      </label>
                    </div>
                    <div className="flex shrink-0 gap-2">
                      <button onClick={() => saveEdit(lt.id)} className="text-sm font-medium" style={{ color: "var(--brand)" }}>
                        儲存
                      </button>
                      <button onClick={() => setEditingId(null)} className="text-sm text-gray-500 hover:underline">
                        取消
                      </button>
                    </div>
                  </>
                ) : (
                  <>
                    <div className="flex items-center gap-2">
                      <span className="font-medium text-gray-800">{lt.name}</span>
                      <span className="rounded bg-gray-100 px-1.5 py-0.5 text-xs text-gray-500">{lt.code}</span>
                      {lt.paid ? (
                        <span className="rounded-full bg-green-100 px-2 py-0.5 text-xs text-green-700">支薪</span>
                      ) : (
                        <span className="rounded-full bg-gray-100 px-2 py-0.5 text-xs text-gray-500">不支薪</span>
                      )}
                      {lt.special && (
                        <span className="rounded-full bg-blue-100 px-2 py-0.5 text-xs text-blue-700">特殊假別</span>
                      )}
                      <span
                        className="rounded-full bg-amber-50 px-2 py-0.5 text-xs text-amber-700"
                        title={lt.deduct_rate !== null && lt.deduct_rate !== undefined ? "已明確設定" : "依「支薪」推算"}
                      >
                        扣薪 {Math.round(effectiveDeductRate(lt) * 100)}%
                      </span>
                    </div>
                    <div className="flex shrink-0 gap-3">
                      <button
                        onClick={() => {
                          setEditingId(lt.id);
                          setEditName(lt.name);
                          setEditPaid(lt.paid);
                          setEditSpecial(lt.special);
                          setEditDeductRate(lt.deduct_rate ?? "");
                        }}
                        className="text-sm text-gray-600 hover:underline"
                      >
                        編輯
                      </button>
                      <button onClick={() => onDelete(lt.id)} className="text-sm text-red-600 hover:underline">
                        刪除
                      </button>
                    </div>
                  </>
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>

      {/* Approval flows */}
      <Card>
        <h2 className="mb-1 text-sm font-medium text-gray-500">簽核流程</h2>
        <p className="mb-4 text-xs text-gray-400">
          勾選的員工即為各類別的簽核者，依勾選順序逐關簽核；未設定則退回任一 HR 管理員單關簽核。
        </p>
        {flowMsg && <p className="mb-3 text-sm text-green-600">{flowMsg}</p>}
        <div className="space-y-6">
          {KINDS.map(({ kind, label }) => {
            const selected = flowDraft[kind] ?? [];
            const flow = flows.find((f) => f.applies_to === kind);
            return (
              <div key={kind} className="rounded-lg border border-gray-100 p-4">
                <div className="mb-3 flex items-center justify-between">
                  <h3 className="font-medium text-gray-800">{label}</h3>
                  <button
                    onClick={() => saveFlow(kind)}
                    className="text-sm font-medium"
                    style={{ color: "var(--brand)" }}
                  >
                    儲存
                  </button>
                </div>
                {employees.length === 0 ? (
                  <Empty>尚無員工可指派</Empty>
                ) : (
                  <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                    {employees.map((emp) => (
                      <label key={emp.id} className="flex items-center gap-2 text-sm text-gray-700">
                        <input
                          type="checkbox"
                          checked={selected.includes(emp.id)}
                          onChange={() => toggleApprover(kind, emp.id)}
                        />
                        {emp.name}
                      </label>
                    ))}
                  </div>
                )}
                {selected.length > 0 && (
                  <p className="mt-3 text-xs text-gray-500">
                    順序：{selected.map((id, i) => `${i + 1}. ${empName.get(id) ?? id}`).join("　")}
                  </p>
                )}
                {!flow && selected.length === 0 && (
                  <p className="mt-2 text-xs text-gray-400">尚未設定（將退回 HR 單關）。</p>
                )}
              </div>
            );
          })}
        </div>
      </Card>
    </>
  );
}
