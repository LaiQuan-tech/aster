import { Router, type Request, type Response, type NextFunction } from "express"
import { z } from "zod"
import { requireAuth } from "../middleware/auth.js"
import { requireTenant } from "../middleware/tenant.js"
import { isFinanceRole, resolveSelf, type SelfEmployee } from "../middleware/scope.js"
import { isBossOrPlatformAdmin } from "../lib/boss.js"
import { actorIsInactive } from "../lib/actor-status.js"
import { loadProjectBossEmpId, loadProjectScope } from "../services/project-scope.js"
import { supabaseAdmin } from "../lib/supabase.js"
import { writeAuditLog } from "../services/audit.js"
import {
  OPTION_LABEL_MAX,
  OPTION_LISTS,
  OPTION_LIST_MAX_ITEMS,
  canManageOptionList,
  findOptionList,
  labelMaxOf,
  maxItemsOf,
  planOptionQuickAdd,
  loadOptionItem,
  loadOptionItems,
  loadOptionUsage,
  planOptionPut,
  serializeOptionItem,
  type OptionListDef,
} from "../services/option-lists.js"

export const optionListsRouter = Router()

/**
 * 全站共用的「選項清單」（管理員可自行新增的下拉選項；機制與規則見 services/option-lists.ts）。
 * 有哪些清單由 `OPTION_LISTS` 登記表決定，這裡的路由對所有清單通用——掛新清單不用改這支檔案。
 *
 * - `GET /option-lists`：清單定義（key／title／description／`canManage`＝呼叫者能不能管理它）。登入即可。
 * - `GET /option-lists/:key`：`items[{code,label,sortOrder,isActive}]`（依 sortOrder 排）。登入即可。
 *     預設只回**啟用**的項目；`?includeInactive=1` 連停用的一起回（畫面要把舊資料的代碼翻成名稱用，
 *     不含使用量，任何登入者都可帶）；`?manage=1` 且呼叫者有管理權限時，回全部項目＋`usage`
 *     （`{ [code]: 被引用筆數 }`，要掃資料表，只有管理頁用）。沒有管理權限時 `manage` 被忽略。
 * - `PUT /option-lists/:key`：整批 upsert——有 `code` 的更新（改名／排序／停用）、沒有的新增（code 由
 *     名稱雜湊產生）。**不在 payload 裡的項目不動、也不會被刪**。名稱 trim 後 1–40 字、同清單不可重複
 *     （正規化後比：大小寫、全半形視為同名），重複回 409 `label_taken`。需管理權限；回管理視圖。
 * - `DELETE /option-lists/:key/:code`：需管理權限。被用過（`usage > 0`，含已軟刪的資料）回 409
 *     `option_in_use`（附 `usage` 筆數），沒用過才刪。
 * - `POST /option-lists/:key/items`（2026-11-12）：快速加入一項 `{ label, projectId? }`。只對登記了 `quickAdd` 的清單開放
 *     （目前：design_discipline＝能編輯專案的人）；管理者一律可用。同名（正規化後）已存在回 200 `{added:false}` 不動資料；
 *     新增回 201 `{added:true}`。名稱超過該清單上限 400 `label_too_long`、清單已滿 400 `too_many_items`。
 * - 清單可另設 `labelMax`／`maxItems`（design_discipline：20 字、50 項），PUT 也照這兩個上限擋。
 * - 管理權限＝`manageRoles`，`bossCanManage` 的清單再加老闆本人（platform_admin 本來就視同老闆）。
 * - 沒登記的 key 一律 404 `list_not_found`；沒管理權限 403 `forbidden`。
 */

const flag = (value: unknown): boolean => value === "1" || value === "true"

function describeList(def: OptionListDef, canManage: boolean) {
  return {
    key: def.key,
    title: def.title,
    description: def.description,
    canManage,
    labelMax: labelMaxOf(def),
    maxItems: maxItemsOf(def),
    quickAdd: def.quickAdd ?? null,
  }
}

/**
 * 呼叫者能不能管理這份清單：角色在 `manageRoles`；`bossCanManage` 的清單另認老闆本人（非在職一律不算）。
 * 只有角色不符、又是 bossCanManage 的清單才查老闆（省一次 DB）。
 */
async function canManageList(tenantId: string, self: SelfEmployee | null, def: OptionListDef, bossCache?: { id?: string | null }): Promise<boolean> {
  if (!self) return false
  if (canManageOptionList(self.role, def)) return true
  if (!def.bossCanManage || actorIsInactive(self)) return false
  if (bossCache && bossCache.id !== undefined) return isBossOrPlatformAdmin(bossCache.id, self)
  const bossId = await loadProjectBossEmpId(tenantId)
  if (bossCache) bossCache.id = bossId
  return isBossOrPlatformAdmin(bossId, self)
}

/** 管理視圖：全部項目（含停用）＋每個項目的使用量。GET ?manage=1 與 PUT 回同一種形狀。 */
async function manageView(tenantId: string, def: OptionListDef) {
  const rows = await loadOptionItems(tenantId, def)
  const usage = await loadOptionUsage(
    tenantId,
    def,
    rows.map((row) => row.code),
  )
  return { ...describeList(def, true), items: rows.map(serializeOptionItem), usage }
}

/** 呼叫者在這個租戶的員工身分；不是這份清單的管理角色就回 403 並回傳 null。 */
async function requireManager(req: Request, res: Response, def: OptionListDef): Promise<SelfEmployee | null> {
  const tenantId = res.locals.tenantId as string
  const userId = req.auth?.userId
  const self = userId ? await resolveSelf(tenantId, userId) : null
  if (!self || !(await canManageList(tenantId, self, def))) {
    res.status(403).json({ error: "forbidden" })
    return null
  }
  return self
}

const putItem = z.object({
  /** 有＝更新既有項目；沒有＝新增（code 由後端產生）。 */
  code: z.string().trim().min(1).max(100).optional(),
  label: z.string().trim().min(1).max(OPTION_LABEL_MAX),
  /** 省略＝維持現狀（新增的項目排在最後）。 */
  sortOrder: z.number().int().min(0).max(1_000_000).optional(),
  /** 省略＝維持現狀（新增的項目預設啟用）。 */
  isActive: z.boolean().optional(),
})

const putBody = z.object({
  items: z.array(putItem).min(1).max(OPTION_LIST_MAX_ITEMS),
})

// ── GET /option-lists ──────────────────────────────────────────────────
optionListsRouter.get("/option-lists", requireAuth, requireTenant, async (req: Request, res: Response, next: NextFunction) => {
  const tenantId = res.locals.tenantId as string
  const userId = req.auth?.userId
  try {
    const self = userId ? await resolveSelf(tenantId, userId) : null
    const bossCache: { id?: string | null } = {}
    const lists = []
    for (const def of OPTION_LISTS) lists.push(describeList(def, await canManageList(tenantId, self, def, bossCache)))
    res.status(200).json({ lists })
  } catch (err) {
    next(err)
  }
})

// ── GET /option-lists/:key ─────────────────────────────────────────────
optionListsRouter.get("/option-lists/:key", requireAuth, requireTenant, async (req: Request, res: Response, next: NextFunction) => {
  const tenantId = res.locals.tenantId as string
  const userId = req.auth?.userId
  const def = findOptionList(req.params.key as string)
  if (!def) {
    res.status(404).json({ error: "list_not_found" })
    return
  }
  try {
    const self = userId ? await resolveSelf(tenantId, userId) : null
    const canManage = await canManageList(tenantId, self, def)
    const withUsage = flag(req.query.manage) && canManage
    const rows = await loadOptionItems(tenantId, def)
    const visible = withUsage || flag(req.query.includeInactive) ? rows : rows.filter((row) => row.is_active !== false)
    const body: Record<string, unknown> = { ...describeList(def, canManage), items: visible.map(serializeOptionItem) }
    if (withUsage) {
      body.usage = await loadOptionUsage(
        tenantId,
        def,
        rows.map((row) => row.code),
      )
    }
    res.status(200).json(body)
  } catch (err) {
    next(err)
  }
})

// ── PUT /option-lists/:key — 管理者整批 upsert ──────────────────────────
optionListsRouter.put("/option-lists/:key", requireAuth, requireTenant, async (req: Request, res: Response, next: NextFunction) => {
  const tenantId = res.locals.tenantId as string
  const def = findOptionList(req.params.key as string)
  if (!def) {
    res.status(404).json({ error: "list_not_found" })
    return
  }
  try {
    const self = await requireManager(req, res, def)
    if (!self) return
    const parsed = putBody.safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_body", details: parsed.error.flatten() })
      return
    }

    const labelMax = labelMaxOf(def)
    const tooLong = parsed.data.items.find((entry) => entry.label.length > labelMax)
    if (tooLong) {
      res.status(400).json({ error: "label_too_long", label: tooLong.label, max: labelMax })
      return
    }

    const existing = await loadOptionItems(tenantId, def)
    const plan = planOptionPut(existing, parsed.data.items, maxItemsOf(def))
    if (!plan.ok) {
      switch (plan.error) {
        case "not_found":
          res.status(404).json({ error: "not_found", code: plan.code })
          return
        case "duplicate_item":
          res.status(400).json({ error: "duplicate_item", code: plan.code })
          return
        case "label_taken":
          res.status(409).json({ error: "label_taken", label: plan.label })
          return
        case "too_many_items":
          res.status(400).json({ error: "too_many_items", max: maxItemsOf(def) })
          return
      }
    }
    // 上面的 switch 已涵蓋所有失敗分支；TypeScript 看不出來，這裡收窄成成功的規劃。
    if (!plan.ok) return

    const now = new Date().toISOString()
    // 先更新（改名順序已排好，不會在中途撞名稱唯一索引）、最後才新增。
    for (const step of plan.updates) {
      const { error } = await supabaseAdmin
        .from("option_items")
        .update({ ...step.patch, updated_at: now })
        .eq("tenant_id", tenantId)
        .eq("list_key", def.key)
        .eq("code", step.code)
      if (error) {
        // 規劃已擋掉重複；走到這裡是競態（另一個管理者剛好改成同名）——仍是名稱重複，不是 500。
        if (error.code === "23505") {
          res.status(409).json({ error: "label_taken" })
          return
        }
        next(new Error(`PUT /option-lists/${def.key} (update ${step.code}): ${error.message}`))
        return
      }
    }
    if (plan.inserts.length > 0) {
      const { error } = await supabaseAdmin
        .from("option_items")
        .insert(plan.inserts.map((row) => ({ tenant_id: tenantId, list_key: def.key, created_by_emp_id: self.id, ...row })))
      if (error) {
        if (error.code === "23505") {
          res.status(409).json({ error: "label_taken" })
          return
        }
        next(new Error(`PUT /option-lists/${def.key} (insert): ${error.message}`))
        return
      }
    }

    await writeAuditLog({
      tenantId,
      tableName: "option_items",
      action: "UPDATE",
      newRow: { listKey: def.key, items: parsed.data.items },
      actorEmpId: self.id,
      context: "PUT /option-lists/:key",
    })
    res.status(200).json(await manageView(tenantId, def))
  } catch (err) {
    next(err)
  }
})

// ── POST /option-lists/:key/items — 快速加入一項（能編輯專案的人；見 OptionListDef.quickAdd） ──
const quickAddBody = z.object({
  label: z.string().max(200),
  projectId: z.string().uuid().optional(),
})

optionListsRouter.post(
  "/option-lists/:key/items",
  requireAuth,
  requireTenant,
  async (req: Request, res: Response, next: NextFunction) => {
    const tenantId = res.locals.tenantId as string
    const userId = req.auth?.userId
    const def = findOptionList(req.params.key as string)
    if (!def) {
      res.status(404).json({ error: "list_not_found" })
      return
    }
    const parsed = quickAddBody.safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_body", details: parsed.error.flatten() })
      return
    }
    try {
      const self = userId ? await resolveSelf(tenantId, userId) : null
      if (!self) {
        res.status(403).json({ error: "forbidden" })
        return
      }
      let allowed = await canManageList(tenantId, self, def)
      if (!allowed && def.quickAdd === "project_editor" && !actorIsInactive(self)) {
        // 能建案（財務層）或能編輯指定的那個案子。
        if (isFinanceRole(self.role)) allowed = true
        else if (parsed.data.projectId) {
          const scope = await loadProjectScope(tenantId, userId as string, parsed.data.projectId)
          allowed = scope.ok && scope.finance
        }
      }
      if (!allowed) {
        res.status(403).json({ error: "forbidden" })
        return
      }

      const existing = await loadOptionItems(tenantId, def)
      const plan = planOptionQuickAdd(existing, parsed.data.label, { labelMax: labelMaxOf(def), maxItems: maxItemsOf(def) })
      if (!plan.ok) {
        res.status(400).json({ error: plan.error, max: plan.error === "too_many_items" ? maxItemsOf(def) : labelMaxOf(def) })
        return
      }
      if (plan.kind === "exists") {
        const hit = existing.find((row) => row.code === plan.code) as (typeof existing)[number]
        res.status(200).json({ added: false, item: serializeOptionItem(hit) })
        return
      }
      const { error } = await supabaseAdmin
        .from("option_items")
        .insert({ tenant_id: tenantId, list_key: def.key, created_by_emp_id: self.id, ...plan.row })
      if (error) {
        // 競態：另一個人剛好同時加了同名 → 當成已存在。
        if (error.code === "23505") {
          const again = await loadOptionItems(tenantId, def)
          const replay = planOptionQuickAdd(again, parsed.data.label, { labelMax: labelMaxOf(def), maxItems: Number.MAX_SAFE_INTEGER })
          const hit = replay.ok && replay.kind === "exists" ? again.find((row) => row.code === replay.code) : undefined
          if (hit) {
            res.status(200).json({ added: false, item: serializeOptionItem(hit) })
            return
          }
          res.status(409).json({ error: "label_taken" })
          return
        }
        next(new Error(`POST /option-lists/${def.key}/items: ${error.message}`))
        return
      }
      await writeAuditLog({
        tenantId,
        tableName: "option_items",
        action: "INSERT",
        newRow: { listKey: def.key, ...plan.row },
        actorEmpId: self.id,
        context: "POST /option-lists/:key/items",
      })
      res.status(201).json({
        added: true,
        item: { code: plan.row.code, label: plan.row.label, sortOrder: plan.row.sort_order, isActive: true },
      })
    } catch (err) {
      next(err)
    }
  },
)

// ── DELETE /option-lists/:key/:code — 只能刪沒被用過的選項 ──────────────
optionListsRouter.delete(
  "/option-lists/:key/:code",
  requireAuth,
  requireTenant,
  async (req: Request, res: Response, next: NextFunction) => {
    const tenantId = res.locals.tenantId as string
    const def = findOptionList(req.params.key as string)
    if (!def) {
      res.status(404).json({ error: "list_not_found" })
      return
    }
    const code = req.params.code as string
    try {
      const self = await requireManager(req, res, def)
      if (!self) return

      const item = await loadOptionItem(tenantId, def.key, code)
      if (!item) {
        res.status(404).json({ error: "not_found", code })
        return
      }
      const usage = (await loadOptionUsage(tenantId, def, [code]))[code] ?? 0
      if (usage > 0) {
        res.status(409).json({ error: "option_in_use", usage })
        return
      }

      const { data: deleted, error } = await supabaseAdmin
        .from("option_items")
        .delete()
        .eq("tenant_id", tenantId)
        .eq("list_key", def.key)
        .eq("code", code)
        .select("id")
      if (error) {
        next(new Error(`DELETE /option-lists/${def.key}/${code}: ${error.message}`))
        return
      }
      if (!deleted || deleted.length === 0) {
        // 讀到之後被別人先刪掉了。
        res.status(404).json({ error: "not_found", code })
        return
      }

      await writeAuditLog({
        tenantId,
        tableName: "option_items",
        recordId: item.id,
        action: "DELETE",
        oldRow: { listKey: def.key, ...item },
        actorEmpId: self.id,
        context: "DELETE /option-lists/:key/:code",
      })
      res.status(200).json({ code })
    } catch (err) {
      next(err)
    }
  },
)
