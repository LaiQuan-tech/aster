/**
 * approval_steps 的候選簽核人小工具（純函式，routes/requests.ts、
 * routes/attachments.ts、services/request-enrich.ts 共用）。
 *
 * 一關的候選＝`candidate_emp_ids`（migration 0049）；null／空陣列＝只有
 * `approver_emp_id` 一人（舊列、或 change-approver 之後）。`approver_emp_id`
 * 永遠算候選之一：建單時它就是 candidate_emp_ids[0]，有人簽後改寫成實際簽的人。
 */

export interface StepLike {
  approver_emp_id: string
  candidate_emp_ids?: unknown
}

/** 這一關可以簽的人（去重、保序；approver_emp_id 若不在陣列內排最前）。 */
export function stepCandidates(step: StepLike): string[] {
  const raw = Array.isArray(step.candidate_emp_ids)
    ? step.candidate_emp_ids.filter((v): v is string => typeof v === "string" && v.length > 0)
    : []
  const out: string[] = []
  if (!raw.includes(step.approver_emp_id)) out.push(step.approver_emp_id)
  for (const id of raw) if (!out.includes(id)) out.push(id)
  return out
}

/** actor 是否輪到簽這一關（是 approver_emp_id 或在候選內）。 */
export function isStepCandidate(step: StepLike, empId: string): boolean {
  return step.approver_emp_id === empId || stepCandidates(step).includes(empId)
}

/** 讀 approval_steps 時要帶的欄位：欄位已套用（schema-compat 探測）才加候選與關卡來源。 */
export function stepSelectCols(base: string, multi: boolean): string {
  return multi ? `${base}, candidate_emp_ids, step_kind` : base
}
