/**
 * 薪資作業頁（admin/payroll）的員工清單＋證件號碼對照（不碰 DOM，可直接單元測試）。
 *
 * 證件號碼只拿來做兩件事：關鍵字搜尋，以及員工下拉下方的「證件號碼：…」。以前是先
 * getEmployees() 再對每位員工各打一次 getEmployeeProfile()（1+N 個請求，業主反映後台頁面慢）；
 * 現在一次 `GET /employees?include=profile` 帶回第一～三證號。第二、三證號只有 HR／平台管理員
 * 拿得到，跟單人 profile（只給本人或 HR）的權限一樣。
 */
import { getEmployees, getEmployeesWithProfile, type Employee, type EmployeeWithProfile } from "./admin-api";

/**
 * 第一～三證號以「 / 」串起來，沒資料的（null／空字串／沒回該鍵）跳過；三個都沒有＝空字串。
 * 與以前逐人查 profile 組出來的字串逐字相同。
 */
export function identityNumbersOf(employee: Pick<EmployeeWithProfile, "idNumber" | "idNumber2" | "idNumber3">): string {
  return [employee.idNumber, employee.idNumber2, employee.idNumber3].filter(Boolean).join(" / ");
}

export interface PayrollEmployees {
  employees: Employee[];
  /** 員工 id → 證件號碼字串；每位員工都有一筆（沒資料或拿不到＝空字串）。 */
  identityById: Record<string, string>;
}

/**
 * 只打一次 `getEmployeesWithProfile()`。它不管為什麼失敗，都退回 `getEmployees()`、證號全部留空——
 * 跟以前「profile 拿不到的那位就空白」一樣，清單照樣能挑人。退回的那次也失敗就讓**那個**錯誤往外丟：
 * 以前唯一的錯誤路徑就是 getEmployees() 失敗，頁面顯示的錯誤字串因此跟以前一樣。
 */
export async function loadPayrollEmployees(): Promise<PayrollEmployees> {
  let list: EmployeeWithProfile[];
  try {
    list = (await getEmployeesWithProfile()).employees;
  } catch {
    const { employees } = await getEmployees();
    return { employees, identityById: Object.fromEntries(employees.map((employee) => [employee.id, ""])) };
  }
  return {
    employees: list,
    identityById: Object.fromEntries(list.map((employee) => [employee.id, identityNumbersOf(employee)])),
  };
}
