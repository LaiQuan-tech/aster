# Punch Cooldown One Second Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Change the default employee punch cooldown from 60 seconds to 1 second while preserving environment overrides and all existing guard semantics.

**Architecture:** Keep the existing pure `cooldownSeconds` parser and `checkPunchCooldown` boundary logic. Change only the exported default constant, its tests, and user-facing operational documentation; no database or API shape changes are required.

**Tech Stack:** TypeScript, Express, Vitest.

---

### Task 1: Change the default cooldown with TDD

**Files:**
- Modify: `apps/api/src/__tests__/punch-guard.test.ts`
- Modify: `apps/api/src/services/punch-guard.ts`
- Modify: `apps/api/src/routes/punch.ts`
- Modify: `docs/交接-2026-09-17-ESS簡化.md`

**Step 1: Write the failing test**

Change the default and invalid/unset environment expectations from `60` to `1`, and add a boundary assertion showing `0.999s` is blocked while `1.000s` is accepted.

**Step 2: Verify RED**

Run: `npm -w @hr/api test -- --run src/__tests__/punch-guard.test.ts`

Expected: FAIL because `DEFAULT_PUNCH_COOLDOWN_SECONDS` is still 60.

**Step 3: Implement the minimum change**

Set `DEFAULT_PUNCH_COOLDOWN_SECONDS = 1` and update comments/documentation that state the old default.

**Step 4: Verify GREEN and regressions**

Run:

```bash
npm -w @hr/api test -- --run src/__tests__/punch-guard.test.ts src/__tests__/punch.test.ts
npm -w @hr/api run typecheck
```

Expected: PASS.

**Step 5: Commit**

```bash
git add apps/api/src/__tests__/punch-guard.test.ts apps/api/src/services/punch-guard.ts apps/api/src/routes/punch.ts docs/交接-2026-09-17-ESS簡化.md
git commit -m "fix(attendance): reduce punch cooldown to one second"
```
