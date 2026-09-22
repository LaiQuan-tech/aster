/**
 * 員工列表「操作」選單的純規則（不碰 React，vitest 直接測）。
 *
 * 規則照 2026-09 之前表格列上那一排文字連結的條件搬過來，只多了「設定密碼」：
 *   - My Data、異動紀錄：永遠出現。
 *   - 已綁登入帳號（user_id 有值）→ 寄重設密碼信＋設定密碼（HR 直接指定一組密碼，2026-09-22 業主要求）
 *     ＋暫時密碼（寄不了信時的備援，灰字）；未綁帳號 → 改成寄邀請信。這四個在該列有請求進行中
 *     （`busy`）時 disabled。
 *   - 停用：只有 status === "active" 才出現（紅字）。inactive 員工沒有「啟用」動作——
 *     原頁是走「編輯」裡的狀態下拉切回在職，這裡不另發明。
 *   - 「編輯」是列上固定的主要按鈕，不在這個清單裡。
 *
 * 頁面拿到 key 之後對回各自既有的 handler；confirm／modal 邏輯不在這裡。
 */

export type EmployeeActionKey =
  | "profile"
  | "send-reset"
  | "set-password"
  | "temp-password"
  | "send-invite"
  | "deactivate"
  | "audit";

export type EmployeeActionTone = "default" | "danger" | "muted";

export interface ActionSpec {
  key: EmployeeActionKey;
  label: string;
  /** danger＝紅字（停用）；muted＝灰字（備援性質的暫時密碼）。 */
  tone?: EmployeeActionTone;
  disabled?: boolean;
  /** 滑鼠停留的補充說明（原本按鈕的 title）。 */
  title?: string;
}

export interface EmployeeActionInput {
  status: string;
  user_id: string | null;
}

export interface EmployeeActionContext {
  /**
   * 這一列就是登入者本人。原頁**沒有**「不能停用自己」的規則、API 也沒擋，
   * 所以目前不影響結果；保留欄位是讓日後要加規則時呼叫端不用改簽名。
   */
  isSelf: boolean;
  /** 該列有帳號相關請求進行中（寄信／產生暫時密碼），對應原頁的 `busyId === employee.id`。 */
  busy?: boolean;
}

export function employeeActionsFor(emp: EmployeeActionInput, ctx: EmployeeActionContext): ActionSpec[] {
  const busy = ctx.busy === true;
  const hasAccount = Boolean(emp.user_id);
  const actions: ActionSpec[] = [{ key: "profile", label: "My Data" }];

  if (hasAccount) {
    actions.push({ key: "send-reset", label: "寄重設密碼信", disabled: busy });
    actions.push({
      key: "set-password",
      label: "設定密碼",
      disabled: busy,
      title: "由 HR 直接指定一組密碼（同仁下次登入須改密碼）",
    });
    actions.push({
      key: "temp-password",
      label: "暫時密碼",
      tone: "muted",
      disabled: busy,
      title: "寄不了信時的備援：產生暫時密碼",
    });
  } else {
    actions.push({ key: "send-invite", label: "寄邀請信", disabled: busy });
  }

  if (emp.status === "active") {
    actions.push({ key: "deactivate", label: "停用", tone: "danger" });
  }

  actions.push({ key: "audit", label: "異動紀錄", title: "誰在什麼時候改了這位員工的資料" });
  return actions;
}

/**
 * `apiFetch` 丟出的錯誤訊息形如 `[422] weak_password`（`[狀態碼] {error|message}`）。
 * 只有後半段是單一 snake_case 代碼時才算得上「錯誤碼」並回傳它；
 * 其餘（`[404] Not Found`、`[500] GET /employees: …`、沒有前綴的字串）一律回 null，
 * 讓呼叫端保留原字串顯示。
 */
export function parseApiErrorCode(message: string): string | null {
  const match = /^\[(\d{3})\]\s+([a-z][a-z0-9_]*)\s*$/i.exec(message.trim());
  return match ? match[2] : null;
}

const PW_UPPER = "ABCDEFGHJKLMNPQRSTUVWXYZ";
const PW_LOWER = "abcdefghijkmnpqrstuvwxyz";
const PW_DIGIT = "23456789";
const PW_SYMBOL = "!@#$%&*?-_";
/** 產生密碼用的字元集：去掉 0/O、1/l/I 這類抄寫時容易混淆的字。 */
const PW_ALL = PW_UPPER + PW_LOWER + PW_DIGIT + PW_SYMBOL;

function pick(alphabet: string, bytes: Uint8Array, i: number): string {
  return alphabet[bytes[i] % alphabet.length];
}

/**
 * 「設定密碼」面板的「產生隨機密碼」：12 碼、大小寫英文＋數字＋符號各至少一個
 * （其餘 8 碼從全部字元隨機），最後用亂數打散順序。用 `crypto.getRandomValues`
 * 不用 Math.random。純函式、不碰 DOM，vitest 直接測。
 */
export function generateRandomPassword(length = 12): string {
  const size = Math.max(length, 8);
  const bytes = new Uint8Array(size * 2);
  crypto.getRandomValues(bytes);
  const chars = [pick(PW_UPPER, bytes, 0), pick(PW_LOWER, bytes, 1), pick(PW_DIGIT, bytes, 2), pick(PW_SYMBOL, bytes, 3)];
  for (let i = chars.length; i < size; i += 1) chars.push(pick(PW_ALL, bytes, i));
  // Fisher–Yates；亂數來源用陣列後半段
  for (let i = chars.length - 1; i > 0; i -= 1) {
    const j = bytes[size + i] % (i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join("");
}
