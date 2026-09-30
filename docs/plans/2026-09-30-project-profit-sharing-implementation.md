# Project Profit Sharing Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make the annual project register, project profit-sharing editor, bonus payout workflow, and exports match the supplied Aster tables while preserving immutable paid history and automatically reconciling future payouts after percentage changes.

**Architecture:** Extend the existing project/member/adjustment and bonus-run snapshot model. Store the project bonus rate and group related share changes into one revision, calculate current pool and unallocated shares in pure functions, then present the same source data in Excel-shaped web tables and exports. Paid bonus items remain immutable snapshots; current settings only affect future cumulative entitlement calculations.

**Tech Stack:** TypeScript, Express 5, Next.js 16, Supabase/Postgres, Drizzle, Vitest, ExcelJS, Tailwind CSS.

---

### Task 1: Database contract for bonus rate and grouped revisions

**Files:**
- Modify: `packages/db/src/schema/projects.ts`
- Modify: `packages/db/src/schema/project-share-adjustments.ts`
- Modify: `packages/db/src/schema/__tests__/schema.test.ts`
- Create: `packages/db/migrations/0052_project_profit_sharing.sql`
- Create: `packages/db/sql/0042_project_profit_sharing.sql`

**Step 1: Write the failing schema test**

Assert that projects exposes `bonusRatePct`, share adjustments expose `changeSetId` and `field` supports the new revision events.

**Step 2: Run the test to verify it fails**

Run: `npm -w @hr/db test -- schema.test.ts`

Expected: FAIL because the columns do not exist.

**Step 3: Add the minimal schema and migration**

Add nullable numeric `projects.bonus_rate_pct` with range 0–100, nullable UUID `project_share_adjustments.change_set_id`, an index by tenant/project/change set, and idempotent SQL protections. Preserve existing `bonus_pool` data.

**Step 4: Run the test to verify it passes**

Run: `npm -w @hr/db test -- schema.test.ts`

Expected: PASS.

**Step 5: Commit**

Commit: `feat(db): add project bonus rate and share revisions`

### Task 2: Pure calculations and batch share revision API

**Files:**
- Create: `apps/api/src/services/project-share-revision.ts`
- Create: `apps/api/src/__tests__/project-share-revision.test.ts`
- Modify: `apps/api/src/routes/projects.ts`
- Modify: `apps/api/src/services/bonus-run.ts`
- Modify: `apps/api/src/services/bonus-run-store.ts`
- Modify: `apps/api/src/__tests__/bonus-run.test.ts`
- Modify: `apps/web/src/lib/projects-api.ts`

**Step 1: Write failing pure-function tests**

Cover pool = contract × bonus rate, member amounts, unallocated percentage and amount, 100% boundary, over-100 rejection, percentage-change catch-up, and overpaid detection.

**Step 2: Run tests and verify the expected failures**

Run: `npm -w @hr/api test -- project-share-revision.test.ts bonus-run.test.ts`

**Step 3: Implement pure calculations**

Keep integer-dollar rounding consistent with bonus-run calculations. A missing rate/pool must produce an explicit non-calculable result rather than silently using zero.

**Step 4: Add failing API behavior tests**

Specify `PUT /projects/:id/share-revision` with `{bonusRatePct, members, reason}`. Require a non-empty reason, reject duplicate employees and totals over 100, verify project scope, and return calculation plus grouped adjustments.

**Step 5: Implement batch revision behavior**

Use one `changeSetId` for all rows. Update the project rate and current members, record adds/removes/role/rate changes, and preserve legacy single-member endpoints. Ensure every query is tenant- and project-scoped.

**Step 6: Wire bonus-run inputs**

When `bonusRatePct` is present, derive the pool from the current contract total; otherwise preserve existing `bonusPool`. Snapshot the rate and derived pool into draft/paid items.

**Step 7: Run tests**

Run: `npm -w @hr/api test -- project-share-revision.test.ts bonus-run.test.ts`

Expected: PASS.

**Step 8: Commit**

Commit: `feat(api): add atomic project share revisions`

### Task 3: Excel-faithful annual project register

**Files:**
- Modify: `apps/api/src/services/project-application-store.ts`
- Modify: `apps/api/src/lib/xlsx/projects-annual.ts`
- Modify: `apps/api/src/__tests__/projects-application.test.ts`
- Modify: `apps/web/src/lib/projects-ext-api.ts`
- Modify: `apps/web/src/app/admin/projects/annual/page.tsx`

**Step 1: Write failing report tests**

Assert the exact reference column order and derived fields: received amount, receivable amount, invoiced amount, contract status, signature/engineer status, subcontract amount, business owner, notes and discipline totals.

**Step 2: Run the test to verify it fails**

Run: `npm -w @hr/api test -- projects-application.test.ts`

**Step 3: Extend annual report projection**

Batch-load only the required contracts, billings, subcontracts and engineer assignments. Do not add N+1 queries. Preserve existing totals-only response compatibility.

**Step 4: Rebuild the web table in reference order**

Use the black bordered header/body style, ROC dates, thousand separators and reference subtotal/total layout. Keep system-only status/progress fields after all reference columns.

**Step 5: Update Excel export**

Match the supplied Aster title rows, column order, widths, borders, number formats, freeze pane and totals. Keep values typed as numbers/dates.

**Step 6: Run focused tests and typecheck**

Run: `npm -w @hr/api test -- projects-application.test.ts && npm -w @hr/web run typecheck`

Expected: PASS.

**Step 7: Commit**

Commit: `feat(projects): match annual register reference format`

### Task 4: Project share editor and revision history UI

**Files:**
- Modify: `apps/web/src/app/admin/projects/[id]/page.tsx`
- Modify: `apps/web/src/app/admin/projects/[id]/_sections/MembersCard.tsx`
- Modify: `apps/web/src/app/admin/projects/[id]/_sections/AdjustmentsCard.tsx`
- Modify: `apps/web/src/lib/projects-api.ts`
- Create: `apps/web/src/lib/__tests__/project-share-calculation.test.ts`

**Step 1: Write failing calculation/UI-model tests**

Cover live member amounts, role order, unallocated share, exact 100%, over-100 blocking and existing data hydration.

**Step 2: Run the test to verify it fails**

Run: `npm -w @hr/web test -- project-share-calculation.test.ts`

**Step 3: Implement the Excel-shaped editor**

Show contract amount, received amount, bonus rate, total bonus, manager, members 1–4, support, unallocated and note/reason. Edit locally and save once through the batch revision API. Require reason and show over-100 errors before calling the API.

**Step 4: Group revision history**

Group adjustments by `changeSetId` and show timestamp, operator, reason and all before/after changes together. Keep legacy ungrouped records visible.

**Step 5: Run tests and typecheck**

Run: `npm -w @hr/web test -- project-share-calculation.test.ts && npm -w @hr/web run typecheck`

Expected: PASS.

**Step 6: Commit**

Commit: `feat(web): add linked project share editor and history`

### Task 5: Bonus payout table and export parity

**Files:**
- Modify: `apps/web/src/lib/bonus-api.ts`
- Modify: `apps/web/src/app/admin/bonus-runs/_components.tsx`
- Modify: `apps/web/src/app/admin/bonus-runs/page.tsx`
- Modify: `apps/web/src/app/admin/bonus-runs/[id]/page.tsx`
- Modify: `apps/api/src/lib/xlsx/bonus-runs.ts`
- Modify: `apps/api/src/__tests__/bonus-run.test.ts`

**Step 1: Write failing serialized-row/export tests**

Require project number/name, contract total, previous received and percentage, current receipt and percentage, cumulative percentage, project bonus rate, total bonus, current bonus, member rate/amount, unallocated and note.

**Step 2: Run tests and verify failure**

Run: `npm -w @hr/api test -- bonus-run.test.ts`

**Step 3: Extend snapshots and API types**

Derive prior/current receipt differences from the frozen item and earlier paid snapshots without changing paid rows.

**Step 4: Match the reference web table**

Use the same grouped headings and column order for preview and batch detail. Preserve pay, reverse, delete-draft and export actions.

**Step 5: Match the reference Excel export**

Use the supplied bonus table’s two-row headings, percentage formats, member columns, unallocated column, notes and totals.

**Step 6: Run tests and typecheck**

Run: `npm -w @hr/api test -- bonus-run.test.ts && npm -w @hr/web run typecheck`

Expected: PASS.

**Step 7: Commit**

Commit: `feat(bonus): match payout register and tracking format`

### Task 6: Cross-links and regression verification

**Files:**
- Modify as needed: `apps/web/src/app/admin/projects/[id]/page.tsx`
- Modify as needed: `apps/web/src/app/admin/disbursements/pivot/page.tsx`
- Modify as needed: `apps/web/src/lib/admin-nav.ts`
- Update: `README.md`

**Step 1: Add project-to-payout and project-to-disbursement links**

Links must preserve project/year filters and existing permissions.

**Step 2: Verify the project application form still contains all supplied Word sections**

Confirm client, contract, billing schedule, invoice, subcontract, other expense, profit and margin fields still use the same project source. Add only missing labels/links; do not duplicate calculations.

**Step 3: Run focused and workspace verification**

Run:

```bash
npm run typecheck
npm -w @hr/rules test
npm -w @hr/db test
npm -w @hr/api test -- project-share-revision.test.ts bonus-run.test.ts projects-application.test.ts disbursement-pivot.test.ts
npm -w @hr/web run build
```

Expected: all commands pass.

**Step 4: Compare against supplied references**

Verify annual table columns, bonus table columns, project application sections and twelve-month payout pivot. Record any intentional screen-only additions after the reference columns.

**Step 5: Final review and commit**

Commit: `docs: document project profit sharing workflow`
