/**
 * 規則版本歷史檢視／比對（M9）＋ 2026-09-23 需求補齊新增的規則鍵型別。
 *
 * 對應後端：
 *   apps/api/src/routes/rule-config.ts   GET /rule-config/versions?full=1
 *   packages/rules/src/rules-schema.ts   overtime.basis / monthlyCapHours / beyondCap、
 *                                        leave.annualLeave*、insurance.brackets
 *
 * 為什麼另開一支而不是塞進 `lib/admin-api.ts`：admin-api 的 `RuleConfig` 是 2026-08
 * 就定形的鏡射型別，多個工作包同時在動它；新鍵一律在這裡用「擴充型別」疊上去
 * （`RuleConfigExt`），admin-api 的 `saveRuleConfig(config)` 照收（結構相容），
 * 兩邊不必同時改。型別同樣是手抄 @hr/rules 的 zod schema（web 不吃 @hr/rules）。
 */
import { apiFetch } from "./api-client";
import type { RuleConfig, RuleConfigOvertime, RuleConfigVersion } from "./admin-api";

/* ---------------------------------------------------------------- 新規則鍵 --- */

/** 加班起算基準：法定每日正常工時（8 小時）／班表淨工時。 */
export type OvertimeBasis = "regularHours" | "shift";
/** 月加班超過上限後：超額另行給付（不進薪資單）／只警示。 */
export type OvertimeBeyondCap = "settle_separately" | "warn";
/** 特休制度：到職日週年制／曆年制。 */
export type AnnualLeaveBasis = "anniversary" | "calendar";

export interface AnnualLeaveTier {
  /** 年資滿幾個月。 */
  minMonths: number;
  /** 給幾天（發放時 × payroll.dailyRegularHours 轉小時）。 */
  days: number;
}

export interface AnnualLeaveIncrement {
  afterMonths: number;
  perYearDays: number;
  maxDays: number;
}

export interface RuleConfigLeave {
  annualLeaveBasis?: AnnualLeaveBasis;
  annualLeaveTable?: AnnualLeaveTier[];
  annualLeaveIncrement?: AnnualLeaveIncrement;
  /** 特休對應的 leave_types.code。 */
  annualLeaveTypeCode?: string;
}

/** 一組投保級距（含生效日）；labor／health 各一串由小到大的投保薪資。 */
export interface InsuranceBracketSet {
  effectiveFrom: string;
  labor: number[];
  health: number[];
}

export interface RuleConfigInsurance {
  labor: { rate: number; employeeShare: number };
  health: { rate: number; employeeShare: number };
  brackets?: InsuranceBracketSet[];
}

export interface RuleConfigOvertimeExt extends RuleConfigOvertime {
  /** 省略 = regularHours。 */
  basis?: OvertimeBasis;
  /** 月加班上限（小時）；省略 = 40（法定 46）。 */
  monthlyCapHours?: number;
  /** 省略 = settle_separately。 */
  beyondCap?: OvertimeBeyondCap;
}

/**
 * `RuleConfig` 加上本次新增的鍵。可以直接餵給 `saveRuleConfig`（欄位是 schema 認得的
 * optional 鍵，後端 parseRuleConfig 會驗）。
 */
export interface RuleConfigExt extends Omit<RuleConfig, "overtime" | "insurance"> {
  overtime: RuleConfigOvertimeExt;
  insurance?: RuleConfigInsurance;
  leave?: RuleConfigLeave;
}

/** 把 admin-api 的 `RuleConfig` 當成擴充型別看（執行期同一個物件，只是型別收窄）。 */
export function asExtConfig(config: RuleConfig): RuleConfigExt {
  return config as unknown as RuleConfigExt;
}

/* ------------------------------------------------- 版本歷史（?full=1） --- */

export interface RuleConfigVersionFull extends RuleConfigVersion {
  /** 該版的規則內容；`configValid: false` 代表舊版 DSL 已不合現行 schema，內容原樣回傳。 */
  config: RuleConfig | null;
  configValid: boolean;
}

/**
 * 版本歷史＋每一版的內容（M9）。後端預設不帶 config（版本一多會很肥），要比對才加 full。
 */
export function getRuleConfigVersionsFull() {
  return apiFetch<RuleConfigVersionFull[]>("/rule-config/versions?full=1");
}

/* ---------------------------------------------------------- 版本比對 --- */

/** 攤平後的一列：`overtime.rules[0].multiplier` → `1.334`。 */
export type FlatConfig = Record<string, string>;

function formatLeaf(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) return "—";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

/**
 * 把規則物件攤平成 `路徑 → 值`。陣列用 `[i]`，物件用 `.key`；葉節點（純值、null、
 * 空物件／空陣列）直接轉字串。比對兩版時只要比同一組 key 的字串值就好，不必遞迴 diff。
 */
export function flattenConfig(value: unknown, prefix = ""): FlatConfig {
  const out: FlatConfig = {};
  if (Array.isArray(value)) {
    if (value.length === 0) {
      out[prefix || "(root)"] = "[]";
      return out;
    }
    value.forEach((item, i) => Object.assign(out, flattenConfig(item, `${prefix}[${i}]`)));
    return out;
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) {
      out[prefix || "(root)"] = "{}";
      return out;
    }
    for (const [k, v] of entries) Object.assign(out, flattenConfig(v, prefix ? `${prefix}.${k}` : k));
    return out;
  }
  out[prefix || "(root)"] = formatLeaf(value);
  return out;
}

export interface ConfigDiffRow {
  path: string;
  /** 基準版的值；`null` ＝ 這個鍵在基準版不存在。 */
  a: string | null;
  /** 比較版的值；`null` ＝ 這個鍵在比較版不存在。 */
  b: string | null;
  kind: "changed" | "added" | "removed";
}

export interface ConfigDiff {
  rows: ConfigDiffRow[];
  /** 兩邊相同的鍵數（畫面上只列差異，這個數字用來說「其餘 N 項相同」）。 */
  sameCount: number;
}

/**
 * 兩版規則的差異（只回不一樣的鍵，依路徑排序）。「不存在」與「值是 null」是兩件事，
 * 所以用 `null` 代表缺鍵、字串 `"null"` 代表值就是 null。
 */
export function diffConfigs(a: unknown, b: unknown): ConfigDiff {
  const fa = flattenConfig(a);
  const fb = flattenConfig(b);
  const paths = [...new Set([...Object.keys(fa), ...Object.keys(fb)])].sort();
  const rows: ConfigDiffRow[] = [];
  let sameCount = 0;
  for (const path of paths) {
    const inA = Object.prototype.hasOwnProperty.call(fa, path);
    const inB = Object.prototype.hasOwnProperty.call(fb, path);
    if (inA && inB && fa[path] === fb[path]) {
      sameCount += 1;
      continue;
    }
    rows.push({
      path,
      a: inA ? fa[path] : null,
      b: inB ? fb[path] : null,
      kind: !inA ? "added" : !inB ? "removed" : "changed",
    });
  }
  return { rows, sameCount };
}
