/**
 * 員工管理頁（admin/employees）列表的個資欄位：顯示與列內編輯用的純函式（不碰 DOM／API，可直接單元測試）。
 *
 * 七個欄位來自 `GET /employees?include=profile`（admin-api 的 EmployeePersonalFields），
 * 寫回走 `PUT /employees/:id/profile`（SaveProfileBody，partial：沒帶的欄位不動）：
 *   生日 birthday、身分證 idNumber、戶籍地 registeredAddress、
 *   匯款帳號 bankCode／bankName／bankAccount／accountHolder。
 */
import type { EmployeePersonalFields, SaveProfileBody } from "./admin-api";

export const PERSONAL_KEYS = [
  "birthday",
  "idNumber",
  "registeredAddress",
  "bankCode",
  "bankName",
  "bankAccount",
  "accountHolder",
] as const;

export type PersonalKey = (typeof PERSONAL_KEYS)[number];

/** 列內編輯表單的狀態：受控 input 一律用字串（沒資料＝空字串）。 */
export type PersonalForm = Record<PersonalKey, string>;

/** 列內編輯表單的初值：API 的 null／沒回該鍵都轉成空字串。 */
export function personalFormFrom(employee: EmployeePersonalFields): PersonalForm {
  const form = {} as PersonalForm;
  for (const key of PERSONAL_KEYS) form[key] = employee[key] ?? "";
  return form;
}

/**
 * 身分證／居留證字號：去頭尾空白、轉大寫。**不**驗格式——外籍居留證、護照號碼的格式
 * 與本國身分證不同，驗了會擋掉合法資料。
 */
export function normalizeIdNumber(raw: string): string {
  return raw.trim().toUpperCase();
}

/** 送出前的欄位值：去頭尾空白（身分證另外轉大寫）；空字串 → null（＝清空該欄）。 */
export function personalValueForSave(key: PersonalKey, raw: string): string | null {
  const value = key === "idNumber" ? normalizeIdNumber(raw) : raw.trim();
  return value === "" ? null : value;
}

/**
 * 只含「有變更」的欄位，直接當 `PUT /employees/:id/profile` 的 body；沒有任何變更回 `{}`
 * （呼叫端據此決定要不要打 API）。
 *
 * 「有變更」＝表單值（去頭尾空白）與列上現值（去頭尾空白）不同，沒資料與空字串視為相同——
 * 所以只是點進編輯、沒動個資欄位就儲存，不會多打一次 PUT、也不會把沒碰的欄位重寫一遍。
 */
export function personalChanges(employee: EmployeePersonalFields, form: PersonalForm): Pick<SaveProfileBody, PersonalKey> {
  const changes: Pick<SaveProfileBody, PersonalKey> = {};
  for (const key of PERSONAL_KEYS) {
    if (form[key].trim() === (employee[key] ?? "").trim()) continue;
    changes[key] = personalValueForSave(key, form[key]);
  }
  return changes;
}

export interface BankDisplay {
  /** 第一行：「代碼 銀行名稱」（只有其一就只顯示那一個）。 */
  bank: string;
  /** 第二行：帳號。 */
  account: string;
  /** 第三行：戶名；與員工姓名相同（忽略空白）或沒填時為空字串＝不顯示。 */
  holder: string;
}

const squash = (value: string) => value.replace(/\s+/g, "");

/** 列表「匯款帳號」欄的內容；三項都空字串＝整格顯示「—」。 */
export function bankDisplay(employee: Pick<EmployeePersonalFields, "bankCode" | "bankName" | "bankAccount" | "accountHolder"> & { name: string }): BankDisplay {
  const code = (employee.bankCode ?? "").trim();
  const name = (employee.bankName ?? "").trim();
  const holder = (employee.accountHolder ?? "").trim();
  return {
    bank: [code, name].filter(Boolean).join(" "),
    account: (employee.bankAccount ?? "").trim(),
    holder: holder && squash(holder) !== squash(employee.name) ? holder : "",
  };
}
