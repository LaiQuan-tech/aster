import { describe, it, expect } from "vitest";
import { ADMIN_ROLES, HR_ROLES, isAccountantRole, isAdminRole, isHrRole } from "../roles";

/**
 * 員工名冊頁（/admin/employees）的寫入入口（編輯、⋯ 選單、新增員工帳號、批次建立帳號、資料異動核准）
 * 用 `isHrRole` 決定要不要顯示：API 端的 PATCH 員工、建立帳號、重設密碼、停用、異動紀錄都是 requireHrAdmin，
 * My Data 維護是「本人或 HR」，會計按了只會 403。
 *
 * 容易踩的坑是用 `isAdminRole`（可進後台）——它包含會計，會把寫入入口也秀給會計。
 */
describe("isHrRole — 員工名冊的寫入入口只給 HR／平台管理員", () => {
  it("hr_admin、platform_admin 是 HR", () => {
    expect(isHrRole("hr_admin")).toBe(true);
    expect(isHrRole("platform_admin")).toBe(true);
    expect([...HR_ROLES].sort()).toEqual(["hr_admin", "platform_admin"]);
  });

  it("會計、主管、一般員工都不是 HR", () => {
    for (const role of ["accountant", "manager", "employee"]) {
      expect(isHrRole(role), role).toBe(false);
    }
  });

  it("取不到角色（null／undefined／空字串）一律當非 HR：寫入入口預設不顯示", () => {
    for (const role of [null, undefined, ""]) {
      expect(isHrRole(role), String(role)).toBe(false);
    }
  });

  it("會計可進後台（isAdminRole）卻不是 HR——員工頁不能用 isAdminRole 判斷寫入入口", () => {
    expect(isAccountantRole("accountant")).toBe(true);
    expect(isAdminRole("accountant")).toBe(true);
    expect(ADMIN_ROLES).toContain("accountant");
    expect(isHrRole("accountant")).toBe(false);
  });
});
