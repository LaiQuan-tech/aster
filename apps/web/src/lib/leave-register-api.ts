import { apiDownload, apiFetch } from "./api-client";

export interface LeaveRegisterType {
  id: string;
  code: string;
  name: string;
}

export interface LeaveRegisterMonth {
  month: number;
  hoursByType: Record<string, number>;
  totalHours: number;
  totalDays: number;
}

export interface LeaveRegister {
  year: number;
  dailyRegularHours: number;
  leaveTypes: LeaveRegisterType[];
  months: LeaveRegisterMonth[];
  totals: {
    hoursByType: Record<string, number>;
    totalHours: number;
    totalDays: number;
  };
}

export interface EmployeeLeaveRegister {
  employee: { id: string; name: string; empNo: string | null; hireDate: string | null };
  register: LeaveRegister;
}

export function getEmployeeLeaveRegister(params: { employeeId: string; year: number }) {
  const query = new URLSearchParams({ employeeId: params.employeeId, year: String(params.year) });
  return apiFetch<EmployeeLeaveRegister>(`/leave-register?${query.toString()}`);
}

export function downloadEmployeeLeaveRegister(params: {
  employeeId: string;
  year: number;
  employeeName: string;
}) {
  const query = new URLSearchParams({ employeeId: params.employeeId, year: String(params.year) });
  const rocYear = params.year - 1911;
  return apiDownload(
    `/leave-register/export.xlsx?${query.toString()}`,
    `${rocYear}年${params.employeeName}請假表.xlsx`,
  );
}
