import { supabaseAdmin } from "./supabase.js"
import { getTenantTimezone } from "./tenant-tz.js"
import { loadDailyRegularHours } from "../services/daily-regular-hours.js"

/**
 * 報表信頭（公司名稱／地址／電話）——出勤統計表 xlsx（routes/exports.ts）與員工內頁的出勤統計表／薪資明細表
 * （services/employee-statements.ts）共用。
 *
 * 沒有 tenants.branding.address/phone 欄位（目前 schema 只有
 * {logoUrl, primaryColor, appName}），所以地址/電話一律先看 branding、
 * 沒有就退回常數——這是任務指示「沒有地址欄就用常數」的實作。
 */

export const DEFAULT_COMPANY_NAME = "亞斯特設計顧問有限公司"
export const DEFAULT_ADDRESS = "新北市三重區新北大道2段260號5樓之2"

interface TenantBranding {
  address?: string
  phone?: string
  appName?: string
}

export interface Letterhead {
  companyName: string
  address: string
  phone: string
  tz: string
  /** 1 天 ＝ 幾小時（規則 payroll.dailyRegularHours）：彙總區「請假合計(天時)」的換算基準，讀不到＝8。 */
  hoursPerDay: number
}

export async function resolveLetterhead(tenantId: string): Promise<Letterhead> {
  const [tenantRes, tz, hoursPerDay] = await Promise.all([
    supabaseAdmin.from("tenants").select("name, branding").eq("id", tenantId).maybeSingle(),
    getTenantTimezone(tenantId),
    loadDailyRegularHours(tenantId),
  ])
  if (tenantRes.error) throw new Error(`exports (tenant): ${tenantRes.error.message}`)
  const branding = (tenantRes.data?.branding ?? {}) as TenantBranding
  return {
    companyName: tenantRes.data?.name || branding.appName || DEFAULT_COMPANY_NAME,
    address: branding.address || DEFAULT_ADDRESS,
    phone: branding.phone || "",
    tz,
    hoursPerDay,
  }
}
