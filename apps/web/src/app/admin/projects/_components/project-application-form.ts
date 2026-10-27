import type { ProjectMemberRole, ShareMode } from "@/lib/projects-api";
// 相對路徑：vitest 沒設 `@/` 別名，純函式測試要能直接載入這支檔案。
import { defaultActiveCompanyId } from "../../../../lib/company-options";
import { parseRoleSharePctDraft, roleSharePctDraftOf, type RoleSharePct } from "../../../../lib/project-share-calculation";
import type {
  BillingKind,
  CreateProjectExtBody,
  InvoiceType,
  PaymentMethod,
  ProjectKind,
} from "@/lib/projects-ext-api";

export interface ProjectApplicationScopeDraft {
  discipline: string;
  item: string;
  amount: string;
}

export interface ProjectApplicationBillingDraft {
  installmentNo: number;
  kind: BillingKind;
  milestone: string;
  percentage: string;
  plannedOn: string;
  overrideAmount: string;
  overrideReason: string;
  note: string;
}

export interface ProjectApplicationEngineerDraft {
  vendorId: string;
  name: string;
  amount: string;
}

export interface ProjectApplicationDraft {
  name: string;
  code: string;
  /** 承接公司（申請單左上角）。"" ＝ 使用者還沒選，送出時用 `selectedCompanyId` 解出預設公司。 */
  companyId: string;
  openedOn: string;
  fiscalYear: string;
  description: string;
  clientId: string;
  kind: ProjectKind;
  parentProjectId: string;
  siteAddress: string;
  siteAreaM2: string;
  designScope: ProjectApplicationScopeDraft[];
  invoiceType: InvoiceType | "";
  paymentMethod: PaymentMethod | "";
  closingDay: string;
  paymentDay: string;
  contractAmount: string;
  billings: ProjectApplicationBillingDraft[];
  engineers: Record<string, ProjectApplicationEngineerDraft>;
  otherExpenses: string;
  deptId: string;
  leadEmpId: string;
  shareMode: ShareMode;
  bonusPool: string;
  /**
   * 本案各角色分潤趴數（2026-10-27，四格字串）。預填租戶的新專案起始值；只有老闆能改、也只有老闆送出
   * （見 toAuthorizedCreateProjectBody）。四格全空白＝本案不設定（送 null）。
   */
  sharePctByRole: Record<ProjectMemberRole, string>;
}

const DEFAULT_STAGES: ReadonlyArray<Pick<ProjectApplicationBillingDraft, "kind" | "milestone" | "percentage">> = [
  { kind: "installment", milestone: "訂金款", percentage: "10" },
  { kind: "installment", milestone: "初步設計", percentage: "10" },
  { kind: "installment", milestone: "五管核准", percentage: "30" },
  { kind: "installment", milestone: "發包後", percentage: "30" },
  { kind: "installment", milestone: "工程50%", percentage: "10" },
  { kind: "installment", milestone: "施工驗收", percentage: "10" },
  { kind: "installment", milestone: "候選綠建築證書", percentage: "" },
  { kind: "guild_advance", milestone: "技師公會代墊", percentage: "" },
];

export function emptyProjectApplicationDraft(
  openedOn: string,
  disciplines: readonly string[],
  /** 租戶的新專案起始值（ProjectSettings.defaultSharePctByRole），預填進「各角色分潤趴數」。 */
  roleShareDefaults?: RoleSharePct | null,
): ProjectApplicationDraft {
  return {
    name: "",
    code: "",
    companyId: "",
    openedOn,
    fiscalYear: "",
    description: "",
    clientId: "",
    kind: "main",
    parentProjectId: "",
    siteAddress: "",
    siteAreaM2: "",
    designScope: [{ discipline: "", item: "", amount: "" }],
    invoiceType: "",
    paymentMethod: "",
    closingDay: "",
    paymentDay: "",
    contractAmount: "",
    billings: DEFAULT_STAGES.map((stage, index) => ({
      installmentNo: index + 1,
      ...stage,
      plannedOn: "",
      overrideAmount: "",
      overrideReason: "",
      note: "",
    })),
    engineers: Object.fromEntries(disciplines.map((discipline) => [discipline, { vendorId: "", name: "", amount: "" }])),
    otherExpenses: "",
    deptId: "",
    leadEmpId: "",
    shareMode: "pool_pct",
    bonusPool: "",
    sharePctByRole: roleSharePctDraftOf(roleShareDefaults),
  };
}

/** 承接公司下拉可選的項目只需要這幾個欄位（名冊 → 公司主體）。`isActive` 缺值當啟用。 */
export interface CompanyOption {
  id: string;
  isDefault: boolean;
  isActive?: boolean;
}

/**
 * 承接公司的預設選項（新表單）：啟用公司裡 isDefault 那間；沒有標預設時取第一間啟用的；沒有可選的回 ""。
 * 停用的公司不會被當預設（預設公司本來就不能停用；名冊裡排第一的也可能是停用的，要跳過）。
 */
export function defaultCompanyIdOf(companies: readonly CompanyOption[]): string {
  return defaultActiveCompanyId(companies);
}

/**
 * 下拉實際顯示／送出的公司：使用者選過的（且還在名冊裡）優先，否則預設公司。
 * 草稿的 companyId 留 ""（＝沒動過），名冊晚一點才載入也不會卡在空值。
 * 編輯既有專案時，專案上已存的公司就算已停用也算「選過的」——保留它，不要悄悄換成預設公司
 * （選項怎麼列見 lib/company-options.ts 的 companyOptions）。
 */
export function selectedCompanyId(chosen: string, companies: readonly CompanyOption[]): string {
  return chosen && companies.some((company) => company.id === chosen) ? chosen : defaultCompanyIdOf(companies);
}

/** 母案下拉的來源列只需要這幾個欄位（`GET /projects` 的列）。`kind` 缺值當主案。 */
export interface ParentProjectSource {
  id: string;
  code: string | null;
  name: string;
  kind?: string | null;
  archivedAt?: string | null;
}

/**
 * 專案明細頁「母案」下拉的選項：只列主案（母案必須是 main）、排除自己；
 * 這案目前掛的母案就算不在清單裡（例如查不到）也保留一個選項，免得畫面把既有資料悄悄顯示成「未指定」。
 * 已封存的主案照列、標「（已封存）」——追加減的流程會把原案封存，它仍是合法的母案。
 * 清單本身來自 `GET /projects`（同租戶）；最後以 API 的 invalid_parent 為準。
 */
export function parentProjectChoices(
  projects: readonly ParentProjectSource[],
  selfId: string | null,
  currentParentId: string | null,
): Array<{ id: string; label: string }> {
  const label = (project: ParentProjectSource) =>
    `${project.code ? `${project.code}　` : ""}${project.name}${project.archivedAt ? "（已封存）" : ""}`;
  const choices = projects
    .filter((project) => (project.kind ?? "main") === "main" && project.id !== selfId)
    .map((project) => ({ id: project.id, label: label(project) }));
  if (currentParentId && !choices.some((choice) => choice.id === currentParentId)) {
    choices.unshift({ id: currentParentId, label: "（目前的母案，不在清單內）" });
  }
  return choices;
}

/**
 * 專案明細頁存「申請單資料」時，母案要不要一起送（`PATCH parentProjectId`）：
 *   • 主案不能掛母案、下拉也不顯示 → 不送
 *   • 沒改（表單值＝專案上目前的母案）→ 不送：每次存申請單都把母案整份送回去，萬一別人剛好改過
 *     就等於悄悄蓋回舊值
 *   • 改了 → 送新的 id；清空（表單 ""）→ 送 null（母案可清空）
 */
export function parentProjectPatch(
  project: { kind: string; parentProjectId: string | null },
  formParentId: string,
): { parentProjectId?: string | null } {
  if (project.kind === "main") return {};
  const next = formParentId || null;
  return next === (project.parentProjectId ?? null) ? {} : { parentProjectId: next };
}

function optionalNumber(value: string): number | null {
  const normalized = value.trim();
  return normalized === "" ? null : Number(normalized);
}

function optionalText(value: string): string | null {
  const normalized = value.trim();
  return normalized === "" ? null : normalized;
}

export function projectApplicationAmounts(
  draft: Pick<ProjectApplicationDraft, "contractAmount">,
  vatRate: number,
): { amountUntaxed: number | null; taxAmount: number | null; amountTotal: number | null } {
  const amountUntaxed = optionalNumber(draft.contractAmount);
  if (amountUntaxed === null || !Number.isFinite(amountUntaxed)) {
    return { amountUntaxed: null, taxAmount: null, amountTotal: null };
  }
  const taxAmount = Math.round(amountUntaxed * vatRate);
  return { amountUntaxed, taxAmount, amountTotal: amountUntaxed + taxAmount };
}

function invalidNonnegative(value: string): boolean {
  if (value.trim() === "") return false;
  const parsed = Number(value);
  return !Number.isFinite(parsed) || parsed < 0;
}

export function projectApplicationErrors(draft: ProjectApplicationDraft): string[] {
  const errors: string[] = [];
  if (!draft.name.trim()) errors.push("請輸入專案名稱");
  // 母案是選填（業主 2026-09-30 會議）：變更設計／追加／代墊可以先開案、之後在專案明細補母案。
  if (invalidNonnegative(draft.siteAreaM2)) errors.push("設計面積須為 0 以上的數字");
  if (invalidNonnegative(draft.contractAmount)) errors.push("合約金額須為 0 以上的數字");
  if (invalidNonnegative(draft.otherExpenses)) errors.push("其他支出須為 0 以上的數字");
  if (invalidNonnegative(draft.bonusPool)) errors.push("獎金池須為 0 以上的數字");
  const roleShare = parseRoleSharePctDraft(draft.sharePctByRole, { allowUnset: true });
  if (!roleShare.ok) errors.push(roleShare.error);
  for (const [index, row] of draft.designScope.entries()) {
    if (!row.discipline.trim() && (row.item.trim() || row.amount.trim())) {
      errors.push(`科別與服務項目第 ${index + 1} 列已填內容或金額，請選擇科別`);
    }
    if (invalidNonnegative(row.amount)) errors.push(`科別與服務項目第 ${index + 1} 列金額須為 0 以上的數字`);
  }
  for (const [discipline, engineer] of Object.entries(draft.engineers)) {
    if (invalidNonnegative(engineer.amount ?? "")) errors.push(`${discipline}協力技師／發包金額須為 0 以上的數字`);
  }
  for (const row of draft.billings) {
    if (row.percentage.trim() !== "") {
      const percentage = Number(row.percentage);
      if (!Number.isFinite(percentage) || percentage < 0 || percentage > 100) {
        errors.push(`第 ${row.installmentNo} 期百分比須介於 0 到 100`);
      }
    }
    if (invalidNonnegative(row.overrideAmount)) errors.push(`第 ${row.installmentNo} 期指定金額須為 0 以上的數字`);
    if (row.overrideAmount.trim() !== "" && !row.overrideReason.trim()) {
      errors.push(`第 ${row.installmentNo} 期填寫指定金額時必須填理由`);
    }
  }
  const schedule = projectApplicationSchedule(draft);
  if (schedule.percentageTotal > 100) {
    errors.push(`一般期款百分比合計不可超過 100%（目前 ${schedule.percentageTotal}%）`);
  }
  if (schedule.rows.some((row) => row.kind === "installment" && (row.effectiveAmount ?? 0) < 0)) {
    errors.push("期款設定會使末期金額小於 0，請降低前期百分比或指定金額");
  }
  if (schedule.unallocatedResidue !== 0) errors.push("期款有效金額合計與合約金額不一致");
  return errors;
}

export function toCreateProjectBody(draft: ProjectApplicationDraft): CreateProjectExtBody {
  const engineers = Object.fromEntries(
    Object.entries(draft.engineers).map(([discipline, assignment]) => [
      discipline,
      assignment.vendorId || assignment.name.trim()
        ? { vendorId: assignment.vendorId || null, name: optionalText(assignment.name) }
        : null,
    ]),
  );
  const contractAmount = optionalNumber(draft.contractAmount);
  const initialSubcontracts = Object.entries(draft.engineers)
    .filter(([, engineer]) => (engineer.amount ?? "").trim() !== "")
    .map(([discipline, engineer], index) => ({
      kind: "subcontract" as const,
      discipline,
      vendorId: engineer.vendorId || null,
      vendorName: optionalText(engineer.name),
      item: `${discipline}協力技師／發包`,
      amount: optionalNumber(engineer.amount ?? "") ?? 0,
      sortOrder: index,
    }));
  return {
    name: draft.name.trim(),
    code: optionalText(draft.code),
    fiscalYear: optionalNumber(draft.fiscalYear),
    description: optionalText(draft.description),
    openedOn: optionalText(draft.openedOn),
    clientId: draft.clientId || null,
    companyId: draft.companyId || null,
    kind: draft.kind,
    parentProjectId: draft.kind === "main" ? null : draft.parentProjectId || null,
    siteAddress: optionalText(draft.siteAddress),
    siteAreaM2: optionalNumber(draft.siteAreaM2),
    designScope: draft.designScope
      .filter((row) => row.discipline.trim())
      .map((row) => ({
        discipline: row.discipline.trim(),
        item: optionalText(row.item),
        amount: optionalNumber(row.amount),
      })),
    invoiceType: draft.invoiceType || null,
    paymentMethod: draft.paymentMethod || null,
    closingDay: optionalText(draft.closingDay),
    paymentDay: optionalText(draft.paymentDay),
    ...(contractAmount === null ? {} : { contractAmount }),
    billings: draft.billings.map((row) => ({
      installmentNo: row.installmentNo,
      kind: row.kind,
      milestone: optionalText(row.milestone),
      percentage: optionalNumber(row.percentage),
      plannedOn: optionalText(row.plannedOn),
      overrideAmount: optionalNumber(row.overrideAmount),
      overrideReason: optionalText(row.overrideReason),
      note: optionalText(row.note),
    })),
    initialSubcontracts,
    engineers,
    otherExpenses: optionalNumber(draft.otherExpenses),
    deptId: draft.deptId || null,
    leadEmpId: draft.leadEmpId || null,
    shareMode: draft.shareMode,
    bonusPool: draft.shareMode === "pool_pct" ? optionalNumber(draft.bonusPool) : null,
    ...roleShareBodyOf(draft),
  };
}

/** 各角色分潤趴數 → 建案 body 的 sharePctByRole（四格全空白＝null；不合法的不送，由 projectApplicationErrors 擋下）。 */
function roleShareBodyOf(draft: ProjectApplicationDraft): Pick<CreateProjectExtBody, "sharePctByRole"> {
  const parsed = parseRoleSharePctDraft(draft.sharePctByRole, { allowUnset: true });
  return parsed.ok ? { sharePctByRole: parsed.value } : {};
}

export interface ProjectApplicationScheduleRow {
  installmentNo: number;
  kind: BillingKind;
  calculatedAmount: number | null;
  residueApplied: number;
  effectiveAmount: number | null;
}

/**
 * 建案畫面用的正式期款演算法鏡像。規則與 API `computeSchedule` 一致：一般期款
 * 先按合約未稅金額四捨五入，尾差由最後一筆未指定金額的一般期款吸收；公會代墊另計。
 */
export function projectApplicationSchedule(draft: ProjectApplicationDraft): {
  rows: ProjectApplicationScheduleRow[];
  percentageTotal: number;
  effectiveTotal: number;
  unallocatedResidue: number;
  guildAdvanceTotal: number;
} {
  const contractTotal = optionalNumber(draft.contractAmount);
  const installments = draft.billings.filter((row) => row.kind !== "guild_advance");
  const advances = draft.billings.filter((row) => row.kind === "guild_advance");
  const percentageTotal = Math.round(installments.reduce((sum, row) => sum + (optionalNumber(row.percentage) ?? 0), 0) * 1000) / 1000;
  const rows: ProjectApplicationScheduleRow[] = installments.map((row) => {
    const override = optionalNumber(row.overrideAmount);
    const calculated = contractTotal === null ? null : Math.round(contractTotal * ((optionalNumber(row.percentage) ?? 0) / 100));
    return {
      installmentNo: row.installmentNo,
      kind: "installment",
      calculatedAmount: override === null ? calculated : null,
      residueApplied: 0,
      effectiveAmount: override ?? calculated,
    };
  });
  let unallocatedResidue = 0;
  if (contractTotal !== null) {
    const preliminary = rows.reduce((sum, row) => sum + (row.effectiveAmount ?? 0), 0);
    const residue = Math.round(contractTotal - preliminary);
    if (residue !== 0) {
      let absorbIndex = -1;
      for (let index = installments.length - 1; index >= 0; index -= 1) {
        if (optionalNumber(installments[index].overrideAmount) === null) {
          absorbIndex = index;
          break;
        }
      }
      if (absorbIndex >= 0) {
        rows[absorbIndex] = {
          ...rows[absorbIndex],
          calculatedAmount: (rows[absorbIndex].calculatedAmount ?? 0) + residue,
          residueApplied: residue,
          effectiveAmount: (rows[absorbIndex].effectiveAmount ?? 0) + residue,
        };
      } else {
        unallocatedResidue = residue;
      }
    }
  }
  let guildAdvanceTotal = 0;
  for (const advance of advances) {
    const override = optionalNumber(advance.overrideAmount);
    const calculated = contractTotal === null || optionalNumber(advance.percentage) === null
      ? null
      : Math.round(contractTotal * ((optionalNumber(advance.percentage) ?? 0) / 100));
    const effectiveAmount = override ?? calculated;
    guildAdvanceTotal += effectiveAmount ?? 0;
    rows.push({
      installmentNo: advance.installmentNo,
      kind: "guild_advance",
      calculatedAmount: override === null ? calculated : null,
      residueApplied: 0,
      effectiveAmount,
    });
  }
  rows.sort((left, right) => left.installmentNo - right.installmentNo);
  return {
    rows,
    percentageTotal,
    effectiveTotal: rows.filter((row) => row.kind === "installment").reduce((sum, row) => sum + (row.effectiveAmount ?? 0), 0),
    unallocatedResidue,
    guildAdvanceTotal: Math.round(guildAdvanceTotal),
  };
}

export function toAuthorizedCreateProjectBody(
  draft: ProjectApplicationDraft,
  access: { canFinance: boolean; canBonus: boolean },
): CreateProjectExtBody {
  const body = toCreateProjectBody(draft);
  const withoutFinance: CreateProjectExtBody = access.canFinance
    ? body
    : {
        ...body,
        contractAmount: undefined,
        billings: undefined,
        initialSubcontracts: undefined,
        otherExpenses: undefined,
        designScope: body.designScope?.map((row) => ({ ...row, amount: null })),
      };
  if (access.canBonus) return withoutFinance;
  // 非老闆不送分潤欄位：分潤模式／獎金池由後端帶預設，各角色分潤趴數由後端複製新專案起始值。
  const { shareMode: _shareMode, bonusPool: _bonusPool, sharePctByRole: _sharePctByRole, ...withoutBonus } = withoutFinance;
  return withoutBonus;
}

export function projectApplicationVisibility(access: { canFinance: boolean; canBonus: boolean }): {
  showFinanceFields: boolean;
  showBonusFields: boolean;
} {
  return { showFinanceFields: access.canFinance, showBonusFields: access.canBonus };
}

export async function createAndOpenProject(
  body: CreateProjectExtBody,
  create: (payload: CreateProjectExtBody) => Promise<{ id: string; code: string | null }>,
  navigate: (href: string) => void,
): Promise<void> {
  const created = await create(body);
  navigate(`/admin/projects/${created.id}`);
}
