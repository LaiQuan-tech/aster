/**
 * 公司主體下拉的選項規則（純函式，後台所有「選公司」的下拉共用）。
 *
 * 公司主體可以「停用」（名冊 → 公司主體）：停用後**新**專案、**新**放款、**新**下包付款的下拉
 * 不再出現它；單據上原本就選著的停用公司照舊留在下拉裡（標「（已停用）」），不然開舊單據編輯時
 * 下拉會悄悄換成別的公司，一存檔就把歷史資料改掉。
 *
 * 後端對應的規則是寫入時擋「新選或改選」停用公司（400 company_inactive），沿用單據上已存的不擋；
 * 這裡是同一條規則的畫面端，讓使用者一開始就選不到。
 */

export interface SelectableCompany {
  id: string;
  name: string;
  isDefault?: boolean;
  /** 沒有這個欄位（例如舊版 API）一律當啟用。 */
  isActive?: boolean;
}

export interface CompanySelectOption {
  id: string;
  /** 下拉顯示的字：公司名，視需要加「（預設）」「（已停用）」。 */
  label: string;
  inactive: boolean;
}

export const COMPANY_DEFAULT_MARK = "（預設）";
export const COMPANY_INACTIVE_MARK = "（已停用）";

export function isCompanyActive(company: { isActive?: boolean }): boolean {
  return company.isActive !== false;
}

/**
 * 下拉的選項＝啟用的公司，再加上「目前已選的公司」（它已停用的話標「（已停用）」，保留在原本的排序位置）。
 * `selectedId` 沒帶／空字串＝新表單，只列啟用的公司。`markDefault` 在預設公司後面加「（預設）」
 * （有的下拉原本就有標、有的沒有，維持各處原本的樣子）。
 */
export function companyOptions(
  companies: readonly SelectableCompany[],
  selectedId?: string | null,
  options: { markDefault?: boolean } = {},
): CompanySelectOption[] {
  return companies
    .filter((company) => isCompanyActive(company) || (!!selectedId && company.id === selectedId))
    .map((company) => {
      const inactive = !isCompanyActive(company);
      const label = `${company.name}${options.markDefault && company.isDefault ? COMPANY_DEFAULT_MARK : ""}${inactive ? COMPANY_INACTIVE_MARK : ""}`;
      return { id: company.id, label, inactive };
    });
}

/**
 * 新表單預設選哪間：啟用公司裡標預設的那間；沒有標預設就取第一間啟用的；沒有可選的回 ""。
 * （停用的公司不會被當成預設——預設公司本來就不能停用。）
 */
export function defaultActiveCompanyId(companies: ReadonlyArray<Pick<SelectableCompany, "id" | "isDefault" | "isActive">>): string {
  const active = companies.filter(isCompanyActive);
  return (active.find((company) => company.isDefault) ?? active[0])?.id ?? "";
}
