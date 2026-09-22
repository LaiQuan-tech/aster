"use client";

import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { Card, EmptyState, InlineError, PrimaryButton, Skeleton, inputCls, labelCls, useToast } from "@/components/admin-ui";
import {
  createDepartment,
  deleteDepartment,
  getDepartments,
  getEmployees,
  getOrgChart,
  updateDepartment,
  type Department,
  type Employee,
  type OrgNode,
} from "@/lib/admin-api";
import { managerIdsOf, managerLabelOf } from "@/lib/manager-order";
import { ManagerOrderEditor } from "./_components/ManagerOrderEditor";
import { OrgTree } from "./_components/OrgTree";

export default function DepartmentsPage() {
  const toast = useToast();
  const [rows, setRows] = useState<Department[]>([]);
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [tree, setTree] = useState<OrgNode[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [name, setName] = useState("");
  const [parentId, setParentId] = useState("");
  /** 有序主管（index 0＝小主管）；送出時整批以 managerEmpIds 給後端。 */
  const [managerEmpIds, setManagerEmpIds] = useState<readonly string[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [editParentId, setEditParentId] = useState("");
  const [editManagerEmpIds, setEditManagerEmpIds] = useState<readonly string[]>([]);

  const employeeName = useMemo(() => {
    return new Map(employees.map((employee) => [employee.id, employee.emp_no ? `${employee.emp_no} · ${employee.name}` : employee.name]));
  }, [employees]);
  const deptName = useMemo(() => new Map(rows.map((row) => [row.id, row.name])), [rows]);
  const childIdsByParent = useMemo(() => {
    const map = new Map<string, Set<string>>();
    for (const row of rows) {
      if (!row.parent_id) continue;
      const children = map.get(row.parent_id) ?? new Set<string>();
      children.add(row.id);
      map.set(row.parent_id, children);
    }
    return map;
  }, [rows]);

  function isDescendant(candidateParentId: string, departmentId: string) {
    const stack = [...(childIdsByParent.get(departmentId) ?? [])];
    const seen = new Set<string>();
    while (stack.length > 0) {
      const id = stack.pop()!;
      if (id === candidateParentId) return true;
      if (seen.has(id)) continue;
      seen.add(id);
      stack.push(...(childIdsByParent.get(id) ?? []));
    }
    return false;
  }

  /** 「主管」欄：多位用「A → B」（後端 managers）；舊 API 沒回 managers 時退回 manager_label，再退回用員工表查 id。 */
  function managerDisplay(department: Department) {
    const label = managerLabelOf(department);
    if (label) return label;
    const ids = managerIdsOf(department);
    return ids.length > 0 ? ids.map((id) => employeeName.get(id) ?? id.slice(0, 8)).join(" → ") : "—";
  }

  /** 部門、員工、組織圖一起抓；三者共用 loading／error，CRUD 後呼叫即同步重畫右側組織圖。 */
  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [deptRes, employeeRes, orgRes] = await Promise.all([getDepartments(), getEmployees(), getOrgChart()]);
      setRows(deptRes.departments);
      setEmployees(employeeRes.employees);
      setTree(orgRes.tree);
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

  async function onCreate(event: FormEvent) {
    event.preventDefault();
    if (!name.trim()) {
      setFormError("請輸入部門名稱");
      return;
    }
    setSubmitting(true);
    setFormError(null);
    try {
      await createDepartment({
        name: name.trim(),
        parentId: parentId || null,
        managerEmpIds: [...managerEmpIds],
      });
      setName("");
      setParentId("");
      setManagerEmpIds([]);
      toast.show("已新增單位", "success");
      await load();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : "新增失敗");
    } finally {
      setSubmitting(false);
    }
  }

  async function saveEdit(id: string) {
    if (!editName.trim()) return;
    try {
      await updateDepartment(id, {
        name: editName.trim(),
        parentId: editParentId || null,
        managerEmpIds: [...editManagerEmpIds],
      });
      setEditingId(null);
      toast.show("已更新單位", "success");
      await load();
    } catch (err) {
      toast.show(err instanceof Error ? err.message : "更新失敗", "error");
    }
  }

  async function onDelete(id: string) {
    if (!window.confirm("確定刪除此部門？")) return;
    try {
      await deleteDepartment(id);
      toast.show("已刪除單位", "success");
      await load();
    } catch (err) {
      toast.show(err instanceof Error ? err.message : "刪除失敗（可能仍有員工歸屬此部門）", "error");
    }
  }

  return (
    <>
      <Card title="新增單位">
        <form onSubmit={onCreate} className="grid grid-cols-1 gap-4 lg:grid-cols-4">
          <div>
            <label className={labelCls}>單位名稱</label>
            <input className={inputCls} value={name} onChange={(event) => setName(event.target.value)} />
          </div>
          <div>
            <label className={labelCls}>上層單位</label>
            <select className={inputCls} value={parentId} onChange={(event) => setParentId(event.target.value)}>
              <option value="">根節點</option>
              {rows.map((row) => <option key={row.id} value={row.id}>{row.code} · {row.name}</option>)}
            </select>
          </div>
          <div className="lg:col-span-2">
            <label className={labelCls}>主管（依簽核順序：第 1 位＝小主管）</label>
            <ManagerOrderEditor
              idPrefix="create"
              value={managerEmpIds}
              onChange={setManagerEmpIds}
              employees={employees}
              employeeName={(id) => employeeName.get(id)}
              disabled={submitting}
            />
          </div>
          <div className="flex items-end lg:col-span-4">
            <PrimaryButton type="submit" disabled={submitting}>{submitting ? "新增中…" : "新增"}</PrimaryButton>
          </div>
        </form>
        {formError && <InlineError className="mt-2">{formError}</InlineError>}
      </Card>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(18rem,24rem)]">
        <Card title="單位列表">
          {error && <InlineError className="mb-3">{error}</InlineError>}
          {loading ? (
            <Skeleton lines={4} />
          ) : rows.length === 0 ? (
            <EmptyState title="尚無單位" hint="請先用上方表單新增第一個單位" />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead>
                  <tr className="border-b border-gray-200 text-xs text-gray-500">
                    <th className="py-2 pr-4">單位代碼</th>
                    <th className="py-2 pr-4">單位名稱</th>
                    <th className="py-2 pr-4">上層單位</th>
                    <th className="py-2 pr-4">主管</th>
                    <th className="py-2">操作</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((department) => (
                    <tr key={department.id} className="border-b border-gray-50">
                      {editingId === department.id ? (
                        <td colSpan={5} className="py-3">
                          <div className="space-y-3" data-editing-department={department.id}>
                            <div className="grid grid-cols-1 gap-3 lg:grid-cols-3">
                              <div className="rounded-md bg-gray-50 px-3 py-2 text-sm font-medium text-gray-500">{department.code}</div>
                              <input className={inputCls} aria-label="單位名稱" value={editName} onChange={(event) => setEditName(event.target.value)} />
                              <select className={inputCls} aria-label="上層單位" value={editParentId} onChange={(event) => setEditParentId(event.target.value)}>
                                <option value="">根節點</option>
                                {rows
                                  .filter((row) => row.id !== department.id && !isDescendant(row.id, department.id))
                                  .map((row) => <option key={row.id} value={row.id}>{row.code} · {row.name}</option>)}
                              </select>
                            </div>
                            <div>
                              <label className={labelCls}>主管（依簽核順序：第 1 位＝小主管）</label>
                              <ManagerOrderEditor
                                idPrefix={`edit-${department.id}`}
                                value={editManagerEmpIds}
                                onChange={setEditManagerEmpIds}
                                employees={employees}
                                employeeName={(id) => employeeName.get(id)}
                              />
                            </div>
                            <div className="flex items-center gap-3">
                              <button onClick={() => void saveEdit(department.id)} className="text-sm font-medium" style={{ color: "var(--brand)" }}>儲存</button>
                              <button onClick={() => setEditingId(null)} className="text-sm text-gray-500 hover:underline">取消</button>
                            </div>
                          </div>
                        </td>
                      ) : (
                        <>
                          <td className="py-3 pr-4 font-mono text-xs text-gray-500">{department.code}</td>
                          <td className="py-3 pr-4 font-medium text-gray-800">{department.name}</td>
                          <td className="py-3 pr-4 text-gray-600">{department.parent_id ? deptName.get(department.parent_id) : "根節點"}</td>
                          <td className="py-3 pr-4 text-gray-600">{managerDisplay(department)}</td>
                          <td className="py-3">
                            <div className="flex gap-3">
                              <button
                                onClick={() => {
                                  setEditingId(department.id);
                                  setEditName(department.name);
                                  setEditParentId(department.parent_id ?? "");
                                  setEditManagerEmpIds(managerIdsOf(department));
                                }}
                                className="text-sm text-gray-600 hover:underline"
                              >
                                編輯
                              </button>
                              <button onClick={() => void onDelete(department.id)} className="text-sm text-red-600 hover:underline">刪除</button>
                            </div>
                          </td>
                        </>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>

        <Card title="組織圖">
          <OrgTree tree={tree} loading={loading} error={error} />
        </Card>
      </div>
    </>
  );
}
