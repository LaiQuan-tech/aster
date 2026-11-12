/** 刪除專案（2026-11-12）：錯誤訊息人性化與卡片靜態渲染。假資料。 */
import { describe, expect, it } from "vitest"
import { renderToStaticMarkup } from "react-dom/server"
import { DeleteProjectCard } from "../DeleteProjectCard"
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
