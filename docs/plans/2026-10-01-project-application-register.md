# Project Application Creation and Excel Register Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make project creation use the project-application form, synchronize contract and billing data, add project detail/application tabs, and replace the simplified project list with the Excel-style annual register whose rows open project detail.

**Architecture:** Reuse the existing project application projection and annual-report projection instead of creating parallel data models. Extend project creation with an optional nested application payload, extract reusable web components for application input and the annual table, and use route links as the project tabs. The main contract remains the authoritative contract amount for all financial projections.

**Tech Stack:** TypeScript, React 19, Next.js 16, Express 5, Supabase/Postgres, Vitest, Tailwind CSS.

---

### Task 1: Define and test the complete creation payload

**Files:**
- Create: `packages/db/sql/0043_project_primary_contract.sql`
- Modify: `packages/db/src/schema/contracts.ts`
- Modify: `apps/api/src/routes/projects.ts`
- Modify: `apps/api/src/routes/contracts.ts`
- Create: `apps/api/src/services/main-contract.ts`
- Modify: `apps/web/src/lib/projects-ext-api.ts`
- Test: `apps/api/src/__tests__/projects-application.test.ts`

**Step 1: Write the failing API contract tests**

Add cases that submit a project with application fields, `primaryContract`, and eight `billings`. Assert validation rejects a negative contract amount, percentage outside 0–100, duplicate installment numbers, and more than one guild-advance row.

**Step 2: Run the focused test and confirm RED**

Run: `npm -w @hr/api test -- --run src/__tests__/projects-application.test.ts`

Expected: new payload cases fail because nested creation fields are not parsed or written.

**Step 3: Add shared request types and validation**

Add an explicit primary-contract marker with a partial unique index for one active primary contract per project. Extend `CreateProjectExtBody` with:

```ts
primaryContract?: {
  title?: string | null
  counterparty?: string | null
  amount: number
  signedOn?: string | null
  copies?: number
} | null
billings?: InstallmentInputExt[]
```

`primaryContract` always represents our signed contractor contract (`docType='contract'`, `ourRole='contractor'`); callers cannot change those authority-defining values.

In `projects.ts`, add matching Zod schemas and keep all existing fields backward compatible.

**Step 4: Implement related-record creation**

After the project insert succeeds, insert the primary contract and replace the billing schedule using the existing contract/billing rules. Return `{ id, code }` only after all requested records succeed. On a related-write failure, remove the newly created unpublished project and return a clear `project_application_create_failed` error. Never delete a pre-existing project. Add a finance-authorized main-contract upsert endpoint, recompute dependent stamp-duty/billing values, and close the existing contracts-read authorization gap so non-finance users cannot read contract amounts.

**Step 5: Run focused tests and typecheck**

Run:

```bash
npm -w @hr/api test -- --run src/__tests__/projects-application.test.ts
npm -w @hr/api run typecheck
```

Expected: PASS.

**Step 6: Commit**

```bash
git add apps/api/src/routes/projects.ts apps/api/src/__tests__/projects-application.test.ts apps/web/src/lib/projects-ext-api.ts
git commit -m "feat(projects): create application data with project"
```

### Task 2: Build the shared project-application input model and creation form

**Files:**
- Create: `apps/web/src/app/admin/projects/_components/ProjectApplicationForm.tsx`
- Create: `apps/web/src/app/admin/projects/_components/project-application-form.ts`
- Modify: `apps/web/src/app/admin/projects/page.tsx`
- Test: `apps/web/src/app/admin/projects/_components/project-application-form.test.ts`

**Step 1: Write failing pure-model tests**

Test default eight billing rows, amount/tax/total derivation, empty-string normalization, percentage validation, and transformation to `CreateProjectExtBody`.

**Step 2: Run the test and confirm RED**

Run: `npx vitest run apps/web/src/app/admin/projects/_components/project-application-form.test.ts`

Expected: FAIL because the form model does not exist.

**Step 3: Implement the pure form model**

Create `ProjectApplicationDraft`, `emptyProjectApplicationDraft()`, `projectApplicationErrors()`, and `toCreateProjectBody()`. Keep identifiers as strings in the draft, numeric inputs as editable strings, and convert only at submit time.

**Step 4: Implement the visual form**

Render sections in the same order as the application sheet: heading/basic data, project details, client/invoice data, sales amount, payment stages, engineers, subcontract/expense summary, and internal project settings. Use the existing `ClientCombo`, employee/department lists, vendor lists, and configured disciplines. Contract amount must be a normal editable numeric input.

**Step 5: Replace the old creation card**

Use `ProjectApplicationForm` in `page.tsx`. Preserve inline client creation and pre-reserved code support. On success, call `router.push('/admin/projects/' + created.id)` instead of clearing the form and staying on the list.

**Step 6: Run tests and typecheck**

Run:

```bash
npx vitest run apps/web/src/app/admin/projects/_components/project-application-form.test.ts
npm -w @hr/web run typecheck
```

Expected: PASS.

**Step 7: Commit**

```bash
git add apps/web/src/app/admin/projects/_components apps/web/src/app/admin/projects/page.tsx
git commit -m "feat(projects): create projects from application form"
```

### Task 3: Add project detail and application tabs

**Files:**
- Create: `apps/web/src/app/admin/projects/[id]/_components/ProjectTabs.tsx`
- Modify: `apps/web/src/app/admin/projects/[id]/page.tsx`
- Modify: `apps/web/src/app/admin/projects/[id]/application/page.tsx`

**Step 1: Add a reusable route-tab component**

Render two links with accessible current-page state:

```tsx
<Link href={`/admin/projects/${projectId}`}>專案明細</Link>
<Link href={`/admin/projects/${projectId}/application`}>專案申請單</Link>
```

**Step 2: Mount tabs on both pages**

Place the tabs directly below the detail heading on the detail page and above the print controls on the application page. Replace the old `列印申請單 →` header action with the persistent tab.

**Step 3: Verify**

Run: `npm -w @hr/web run typecheck`

Expected: PASS and both routes retain the same project id.

**Step 4: Commit**

```bash
git add apps/web/src/app/admin/projects/[id]
git commit -m "feat(projects): add application tab to project detail"
```

### Task 4: Reuse the Excel-style annual register on the project index

**Files:**
- Create: `apps/web/src/app/admin/projects/_components/AnnualProjectRegister.tsx`
- Create: `apps/web/src/app/admin/projects/_components/annual-project-register.ts`
- Modify: `apps/web/src/app/admin/projects/annual/page.tsx`
- Modify: `apps/web/src/app/admin/projects/page.tsx`
- Modify: `apps/web/src/lib/projects-ext-api.ts`
- Test: `apps/web/src/app/admin/projects/_components/annual-project-register.test.ts`

**Step 1: Write failing projection/format tests**

Assert the exact Excel A:S column order (`項次` through `汙水`), ROC date display, accounting-style whole-number money display, subtotal labels in the engineering-name column, and the detail URL for a row.

**Step 2: Run the test and confirm RED**

Run: `npx vitest run apps/web/src/app/admin/projects/_components/annual-project-register.test.ts`

Expected: FAIL because the shared projection does not exist.

**Step 3: Extract the existing annual table**

Move the table from `annual/page.tsx` to `AnnualProjectRegister`. Match the reference workbook: title merges only across A:P, Kai font, white background, black thin borders for A:P, column-width proportions, row heights, fixed `空調／消防／汙水` columns, monthly subtotals, and annual total. Use `金額`, not `金額(未稅)`. Do not append the four non-Excel system columns. Keep subtotal cells A:D separate and put the label only in E.

**Step 4: Make every project row navigable**

Use `router.push('/admin/projects/' + row.projectId)` for row click and Enter/Space. Keep actual links on the project number and project name. Guard interactive descendants so clicking a link or control does not double-navigate.

**Step 5: Replace the simplified index table**

Load the selected year's annual report and render `AnnualProjectRegister` below the creation form. Preserve year, sorting, status, archived, and reserved controls. Apply status/reserved visibility without changing financial totals unexpectedly; when filters narrow displayed rows, label totals as annual-source totals rather than recomputing incomplete values.

**Step 6: Run tests and typecheck**

Run:

```bash
npx vitest run apps/web/src/app/admin/projects/_components/annual-project-register.test.ts
npm -w @hr/web run typecheck
```

Expected: PASS.

**Step 7: Commit**

```bash
git add apps/web/src/app/admin/projects
git commit -m "feat(projects): show Excel annual register on project index"
```

### Task 5: Integrated verification, review, and delivery

**Files:**
- Modify as required by verified failures only.

**Step 1: Run focused and full verification**

Run:

```bash
npm -w @hr/api test -- --run src/__tests__/projects-application.test.ts src/__tests__/projects-annual-reference.test.ts
npm -w @hr/api run typecheck
npm -w @hr/web run typecheck
npm run build
```

Expected: all commands exit 0.

**Step 2: Visual verification**

Start the local application, open the project index and a project detail/application route, and compare against the supplied application-form and Excel screenshots at desktop width. Check horizontal scrolling, sticky headers, row click, tab state, editable contract amount, and calculated totals.

**Step 3: Request code review**

Review spec compliance first, then code quality. Resolve all blocking findings and rerun affected tests.

**Step 4: Commit verification fixes**

```bash
git add -A
git commit -m "fix(projects): complete application and register integration"
```

Skip the commit if verification required no code changes.

**Step 5: Merge and push**

Fast-forward or merge `codex/project-application-register` into `main`, rerun the focused verification on `main`, and push `main` to `origin`.
