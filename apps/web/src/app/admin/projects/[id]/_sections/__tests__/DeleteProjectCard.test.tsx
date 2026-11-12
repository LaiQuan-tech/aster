/** 刪除專案（2026-11-12）：錯誤訊息人性化與卡片靜態渲染。假資料。 */
import { describe, expect, it } from "vitest"
import { renderToStaticMarkup } from "react-dom/server"
import { DeleteProjectCard, DeleteProjectDialog, submitProjectDelete, type DeleteProjectDialogProps } from "../DeleteProjectCard"
import { humanizeProjectDeleteError, type ProjectDetail } from "@/lib/projects-ext-api"

const apiErr = (body: Record<string, unknown>) => Object.assign(new Error(String(body.error)), { body })

describe("humanizeProjectDeleteError", () => {
  it("409 project_has_data：用後端說明並帶回 blockers", () => {
    const h = humanizeProjectDeleteError(
      apiErr({
        error: "project_has_data",
        message: "此專案已有實際資料，不能刪除：工時（1 筆）。若只是不再使用，請改用「封存」。",
        blockers: [{ key: "attendance_days", label: "工時", count: 1 }],
      }),
    )
    expect(h.message).toContain("封存")
    expect(h.blockers).toEqual([{ key: "attendance_days", label: "工時", count: 1 }])
  })
  it("409 有 blockers 時 message 只放總結句，不重複列原因（畫面另列清單，只留一份）", () => {
    const h = humanizeProjectDeleteError(
      apiErr({
        error: "project_has_data",
        message: "此專案已有實際資料，不能刪除：出勤表工時（1 筆）、副委託期款已付款或已驗收（2 筆）。若只是不再使用，請改用「封存」。",
        blockers: [
          { key: "attendance_days", label: "出勤表工時", count: 1 },
          { key: "paid_subcontract_payments", label: "副委託期款已付款或已驗收", count: 2 },
        ],
      }),
    )
    expect(h.message).toContain("封存")
    expect(h.message).not.toContain("出勤表工時")
    expect(h.message).not.toContain("副委託期款")
    expect(h.blockers).toHaveLength(2)
  })
  it("409 沒有 blockers（舊版後端）時仍用後端說明", () => {
    const h = humanizeProjectDeleteError(apiErr({ error: "project_has_data", message: "後端說明：工時（1 筆）" }))
    expect(h.message).toBe("後端說明：工時（1 筆）")
  })
  it("權限／確認不符／找不到", () => {
    expect(humanizeProjectDeleteError(apiErr({ error: "project_delete_forbidden" })).message).toContain("老闆")
    expect(humanizeProjectDeleteError(apiErr({ error: "confirm_mismatch" })).message).toContain("不符")
    expect(humanizeProjectDeleteError(apiErr({ error: "not_found" })).message).toContain("找不到")
  })
})

describe("DeleteProjectCard 靜態渲染", () => {
  it("有紅色刪除按鈕、預設不開確認框", () => {
    const project = { id: "p1", code: "ZZ-115-001", name: "假專案" } as unknown as ProjectDetail
    const html = renderToStaticMarkup(<DeleteProjectCard project={project} onDeleted={() => {}} />)
    expect(html).toContain('data-testid="delete-project-button"')
    expect(html).toContain("刪除專案")
    expect(html).toContain("封存")
    expect(html).not.toContain('data-testid="delete-project-dialog"')
  })
})

describe("送出流程（submitProjectDelete → DeleteProjectDialog）", () => {
  const base: DeleteProjectDialogProps = {
    project: { code: "ZZ-115-001", name: "假專案" },
    typed: "ZZ-115-001",
    busy: false,
    error: null,
    blockers: [],
    restoredNotice: null,
    onTyped: () => {},
    onSubmit: () => {},
    onClose: () => {},
    onDone: () => {},
  }
  const count = (html: string, needle: string) => html.split(needle).length - 1

  it("409 project_has_data：原因清單在畫面上只出現一次（總結句不再重複列）", async () => {
    const outcome = await submitProjectDelete(async () => {
      throw apiErr({
        error: "project_has_data",
        message: "此專案已有實際資料，不能刪除：出勤表工時（1 筆）。若只是不再使用，請改用「封存」。",
        blockers: [{ key: "attendance_days", label: "出勤表工時", count: 1 }],
      })
    })
    expect(outcome.kind).toBe("error")
    if (outcome.kind !== "error") return
    const html = renderToStaticMarkup(<DeleteProjectDialog {...base} error={outcome.message} blockers={outcome.blockers} />)
    expect(count(html, "出勤表工時")).toBe(1)
    expect(html).toContain('data-testid="delete-project-blockers"')
    expect(html).toContain("封存")
    expect(html).toContain('data-testid="delete-project-submit"')
  })

  it("成功且有原案說明：顯示說明與「回專案列表」，不再有確認刪除鈕", async () => {
    const outcome = await submitProjectDelete(async () => ({
      id: "p1", code: "ZZ-115-001", deleted: true,
      restored: [{ id: "o1", code: "ZZ-115-000", mode: "restored", archived: false }],
      restoredMessage: "原案 ZZ-115-000 已解除「被取代」標記並恢復為未封存",
    }))
    expect(outcome).toEqual({ kind: "notice", message: "原案 ZZ-115-000 已解除「被取代」標記並恢復為未封存" })
    if (outcome.kind !== "notice") return
    const html = renderToStaticMarkup(<DeleteProjectDialog {...base} restoredNotice={outcome.message} />)
    expect(html).toContain('data-testid="delete-project-restored"')
    expect(html).toContain("ZZ-115-000")
    expect(html).toContain('data-testid="delete-project-done"')
    expect(html).toContain("回專案列表")
    expect(html).not.toContain('data-testid="delete-project-submit"')
  })

  it("成功、沒有原案說明 → done（直接回列表）", async () => {
    expect(await submitProjectDelete(async () => ({ id: "p1", code: null, deleted: true, restoredMessage: null }))).toEqual({ kind: "done" })
  })
})
