"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Card, Empty, ErrorText, PrimaryButton } from "@/components/admin-ui";
import { BatchImportButton } from "@/components/BatchImport";
import { apiDownload } from "@/lib/api-client";
import {
  getEmployees,
  getSalaryAdjustments,
  getNonEmployeeIncome,
  createNonEmployeeIncome,
  computeTax,
  type Employee,
  type SalaryAdjustment,
  type NonEmployeeIncome,
} from "@/lib/admin-api";

const inputCls =
  "w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-gray-400 focus:outline-none";
const labelCls = "mb-1 block text-xs font-medium text-gray-500";

export default function PayrollTaxPage() {
  const [error, setError] = useState<string | null>(null);
  const [employees, setEmployees] = useState<Employee[]>([]);

  // 調薪紀錄（批次調薪改走 BatchImportButton 的 Excel 範本面板）
  const [adjustments, setAdjustments] = useState<SalaryAdjustment[]>([]);
  const [adjustmentEmployeeId, setAdjustmentEmployeeId] = useState("");

  // 非員工所得
  const [nei, setNei] = useState<NonEmployeeIncome[]>([]);
  const [payee, setPayee] = useState("");
  const [payeeIdNumber, setPayeeIdNumber] = useState("");
  const [amount, setAmount] = useState("");
  const [incomeType, setIncomeType] = useState("");
  const [payDate, setPayDate] = useState("");
  const [withholdRate, setWithholdRate] = useState("0.1");
  const [neiNote, setNeiNote] = useState("");

  // 補充保費試算
  const [calcAmount, setCalcAmount] = useState("50000");
  const [withholdingAmount, setWithholdingAmount] = useState("60000");
  const [calcResult, setCalcResult] = useState<string | null>(null);
  const [withholdingResult, setWithholdingResult] = useState<string | null>(null);

  const empName = useCallback((id: string) => {
    const employee = employees.find((item) => item.id === id);
    if (!employee) return id.slice(0, 8);
    return employee.emp_no ? `${employee.emp_no} · ${employee.name}` : employee.name;
  }, [employees]);

  const loadAdjustments = useCallback(async () => {
    try {
      const res = await getSalaryAdjustments(adjustmentEmployeeId || undefined);
      setAdjustments(res["salary-adjustments"]);
    } catch (err) {
      setError(err instanceof Error ? err.message : "載入調薪紀錄失敗");
    }
  }, [adjustmentEmployeeId]);

  const loadNei = useCallback(async () => {
    try {
      const res = await getNonEmployeeIncome();
      setNei(res["non-employee-income"]);
    } catch (err) {
      setError(err instanceof Error ? err.message : "載入失敗");
    }
  }, []);

  useEffect(() => {
    getEmployees().then((res) => setEmployees(res.employees)).catch(() => null);
    void loadNei();
  }, [loadNei]);

  useEffect(() => {
    void loadAdjustments();
  }, [loadAdjustments]);

  async function onCreateNei(e: FormEvent) {
    e.preventDefault();
    if (!payee.trim() || !amount) return;
    try {
      await createNonEmployeeIncome({
        payeeName: payee.trim(),
        idNumber: payeeIdNumber.trim() || undefined,
        incomeType: incomeType.trim() || undefined,
        amount: Number(amount),
        withholdRate: withholdRate ? Number(withholdRate) : 0,
        payDate: payDate || undefined,
        note: neiNote.trim() || undefined,
      });
      setPayee("");
      setPayeeIdNumber("");
      setAmount("");
      setIncomeType("");
      setPayDate("");
      setWithholdRate("0.1");
      setNeiNote("");
      await loadNei();
    } catch (err) {
      setError(err instanceof Error ? err.message : "新增失敗");
    }
  }

  async function onCalc() {
    try {
      const res = await computeTax({
        kind: "bonus_premium",
        monthlyInsuredSalary: 40000,
        cumulativeBonusBefore: 0,
        thisBonus: Number(calcAmount),
      });
      setCalcResult(`補充保費：NT$ ${res.premium ?? 0}（投保 40,000 假設）`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "試算失敗");
    }
  }

  async function onWithholdingCalc() {
    try {
      const res = await computeTax({
        kind: "withholding",
        monthlyPayment: Number(withholdingAmount),
        rate: 0.05,
        threshold: 0,
      });
      setWithholdingResult(`扣繳稅額：NT$ ${res.withholding ?? 0}（5% 試算）`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "扣繳試算失敗");
    }
  }

  return (
    <>
      <Card>
        <h2 className="mb-3 text-sm font-medium text-gray-500">申報作業匯出</h2>
        <div className="flex gap-3">
          <PrimaryButton type="button" onClick={() => apiDownload("/tax-filing/export?type=withholding", "扣繳申報明細.csv").catch((e) => setError(e.message))}>
            扣繳申報明細 CSV
          </PrimaryButton>
          <PrimaryButton type="button" onClick={() => apiDownload("/tax-filing/export?type=supplementary", "補充保費明細.csv").catch((e) => setError(e.message))}>
            補充保費明細 CSV
          </PrimaryButton>
        </div>
      </Card>
      {error && <div className="mb-3"><ErrorText>{error}</ErrorText></div>}

      <Card>
        <div className="mb-4 flex items-center justify-between gap-3">
          <h2 className="text-sm font-medium text-gray-500">調薪紀錄查詢</h2>
          {/* 批次調薪改成「下載 Excel 範本 → 填完上傳」的面板（原本是一張貼 CSV 的卡片）。 */}
          <BatchImportButton kind="salary-adjustments" label="批次調薪" onDone={loadAdjustments} />
        </div>
        <div className="mb-4 flex flex-wrap items-end gap-3">
          <div>
            <label className={labelCls}>員工</label>
            <select className={inputCls} value={adjustmentEmployeeId} onChange={(event) => setAdjustmentEmployeeId(event.target.value)}>
              <option value="">全部員工</option>
              {employees.map((employee) => (
                <option key={employee.id} value={employee.id}>{empName(employee.id)}</option>
              ))}
            </select>
          </div>
          <PrimaryButton type="button" onClick={() => void loadAdjustments()}>查詢</PrimaryButton>
        </div>
        {adjustments.length === 0 ? (
          <Empty>尚無調薪紀錄</Empty>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-gray-200 text-xs text-gray-500">
                  <th className="py-2 pr-4">員工</th>
                  <th className="py-2 pr-4">生效日</th>
                  <th className="py-2 pr-4">新薪資</th>
                  <th className="py-2">原因</th>
                </tr>
              </thead>
              <tbody>
                {adjustments.map((adjustment) => (
                  <tr key={adjustment.id} className="border-b border-gray-50">
                    <td className="py-2 pr-4 font-medium text-gray-800">{empName(adjustment.employee_id)}</td>
                    <td className="py-2 pr-4">{adjustment.effective_date}</td>
                    <td className="py-2 pr-4">{adjustment.new_salary}</td>
                    <td className="py-2">{adjustment.reason ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card>
        <h2 className="mb-4 text-sm font-medium text-gray-500">非員工所得（自動計算補充保費）</h2>
        <form onSubmit={onCreateNei} className="mb-4 space-y-3">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-4">
            <div>
              <label className={labelCls}>受款人</label>
              <input className={inputCls} value={payee} onChange={(e) => setPayee(e.target.value)} placeholder="講師甲" />
            </div>
            <div>
              <label className={labelCls}>身分證 / 統編</label>
              <input className={inputCls} value={payeeIdNumber} onChange={(e) => setPayeeIdNumber(e.target.value)} placeholder="A123456789" />
            </div>
            <div>
              <label className={labelCls}>所得類別</label>
              <input className={inputCls} value={incomeType} onChange={(e) => setIncomeType(e.target.value)} placeholder="執行業務" />
            </div>
            <div>
              <label className={labelCls}>金額</label>
              <input className={inputCls} type="number" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="50000" />
            </div>
            <div>
              <label className={labelCls}>扣繳率</label>
              <input className={inputCls} type="number" step="0.01" min="0" max="1" value={withholdRate} onChange={(e) => setWithholdRate(e.target.value)} />
            </div>
            <div>
              <label className={labelCls}>給付日期</label>
              <input className={inputCls} type="date" value={payDate} onChange={(e) => setPayDate(e.target.value)} />
            </div>
            <div className="sm:col-span-2">
              <label className={labelCls}>備註</label>
              <input className={inputCls} value={neiNote} onChange={(e) => setNeiNote(e.target.value)} />
            </div>
          </div>
          <PrimaryButton type="submit">新增非員工所得</PrimaryButton>
        </form>
        {nei.length === 0 ? (
          <Empty>尚無資料</Empty>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-gray-200 text-xs text-gray-500">
                  <th className="py-2 pr-4">受款人</th>
                  <th className="py-2 pr-4">證號</th>
                  <th className="py-2 pr-4">所得類別</th>
                  <th className="py-2 pr-4">給付日</th>
                  <th className="py-2 pr-4">金額</th>
                  <th className="py-2 pr-4">扣繳</th>
                  <th className="py-2 pr-4">補充保費</th>
                  <th className="py-2">備註</th>
                </tr>
              </thead>
              <tbody>
                {nei.map((row) => (
                  <tr key={row.id} className="border-b border-gray-50">
                    <td className="py-2 pr-4 font-medium text-gray-800">{row.payee_name}</td>
                    <td className="py-2 pr-4">{row.id_number ?? "—"}</td>
                    <td className="py-2 pr-4">{row.income_type ?? "—"}</td>
                    <td className="py-2 pr-4">{row.pay_date ?? "—"}</td>
                    <td className="py-2 pr-4">{row.amount}</td>
                    <td className="py-2 pr-4">{row.tax_withheld}</td>
                    <td className="py-2 pr-4">{row.supplementary_premium}</td>
                    <td className="py-2">{row.note ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card>
        <h2 className="mb-4 text-sm font-medium text-gray-500">二代健保補充保費試算（高額獎金）</h2>
        <div className="flex items-end gap-3">
          <div>
            <label className={labelCls}>本次獎金</label>
            <input className={inputCls} type="number" value={calcAmount} onChange={(e) => setCalcAmount(e.target.value)} />
          </div>
          <PrimaryButton type="button" onClick={onCalc}>
            試算
          </PrimaryButton>
        </div>
        {calcResult && <p className="mt-3 text-sm text-gray-700">{calcResult}</p>}
      </Card>

      <Card>
        <h2 className="mb-4 text-sm font-medium text-gray-500">所得稅扣繳試算</h2>
        <div className="flex items-end gap-3">
          <div>
            <label className={labelCls}>給付總額</label>
            <input className={inputCls} type="number" value={withholdingAmount} onChange={(event) => setWithholdingAmount(event.target.value)} />
          </div>
          <PrimaryButton type="button" onClick={onWithholdingCalc}>
            試算
          </PrimaryButton>
        </div>
        {withholdingResult && <p className="mt-3 text-sm text-gray-700">{withholdingResult}</p>}
      </Card>
    </>
  );
}
