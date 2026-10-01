import type { ShareMode } from "@/lib/projects-api";
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
}

export interface ProjectApplicationDraft {
  name: string;
  code: string;
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
  startsOn: string;
  endsOn: string;
  shareMode: ShareMode;
  bonusPool: string;
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
): ProjectApplicationDraft {
  return {
    name: "",
    code: "",
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
    engineers: Object.fromEntries(disciplines.map((discipline) => [discipline, { vendorId: "", name: "" }])),
    otherExpenses: "",
    deptId: "",
    leadEmpId: "",
    startsOn: "",
    endsOn: "",
    shareMode: "pool_pct",
    bonusPool: "",
  };
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
  if (draft.kind !== "main" && !draft.parentProjectId) errors.push("變更設計／追加／代墊必須選擇母案");
  if (invalidNonnegative(draft.siteAreaM2)) errors.push("設計面積須為 0 以上的數字");
  if (invalidNonnegative(draft.contractAmount)) errors.push("合約金額須為 0 以上的數字");
  if (invalidNonnegative(draft.otherExpenses)) errors.push("其他支出須為 0 以上的數字");
  if (invalidNonnegative(draft.bonusPool)) errors.push("獎金池須為 0 以上的數字");
  for (const [index, row] of draft.designScope.entries()) {
    if (invalidNonnegative(row.amount)) errors.push(`科別與服務項目第 ${index + 1} 列金額須為 0 以上的數字`);
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
  if (draft.startsOn && draft.endsOn && draft.startsOn > draft.endsOn) errors.push("預定結束日不可早於開始日");
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
  return {
    name: draft.name.trim(),
    code: optionalText(draft.code),
    fiscalYear: optionalNumber(draft.fiscalYear),
    description: optionalText(draft.description),
    openedOn: optionalText(draft.openedOn),
    clientId: draft.clientId || null,
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
    engineers,
    otherExpenses: optionalNumber(draft.otherExpenses),
    deptId: draft.deptId || null,
    leadEmpId: draft.leadEmpId || null,
    startsOn: optionalText(draft.startsOn),
    endsOn: optionalText(draft.endsOn),
    shareMode: draft.shareMode,
    bonusPool: draft.shareMode === "pool_pct" ? optionalNumber(draft.bonusPool) : null,
  };
}
