// Package entry (package.json "main"). Re-exports the drizzle schema barrel and
// the typed seed data so consumers that can build TS source (drizzle-kit,
// scripts, tests) import from "@hr/db" instead of deep paths.
export * from "./schema/index"
export { TW_HOLIDAYS, type TwHoliday } from "./seed/tw-holidays"
