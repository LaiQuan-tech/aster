import type { BonusRunItem } from "./bonus-api";

export interface BonusRegisterRow {
  project: BonusRunItem;
  items: BonusRunItem[];
  currentBonus: number;
  manager: BonusRunItem | null;
  team: Array<BonusRunItem | null>;
  support: BonusRunItem | null;
  overflowMembers: BonusRunItem[];
}

export function buildBonusRegisterRows(items: BonusRunItem[]): BonusRegisterRow[] {
  const groups = new Map<string, BonusRunItem[]>();
  for (const item of items) groups.set(item.projectId, [...(groups.get(item.projectId) ?? []), item]);
  const employeeOrder = (a: BonusRunItem, b: BonusRunItem) =>
    (a.empNo ?? "").localeCompare(b.empNo ?? "") || (a.employeeName ?? "").localeCompare(b.employeeName ?? "");
  return [...groups.values()].map((group) => {
    const managers = group.filter((item) => item.roleInProject === "manager").sort(employeeOrder);
    const supports = group.filter((item) => item.roleInProject === "support").sort(employeeOrder);
    const allTeam = group
      .filter((item) => item.roleInProject !== "manager" && item.roleInProject !== "support")
      .sort((a, b) => (a.roleInProject === "lead" ? 0 : 1) - (b.roleInProject === "lead" ? 0 : 1) || employeeOrder(a, b));
    const team: Array<BonusRunItem | null> = allTeam.slice(0, 4);
    while (team.length < 4) team.push(null);
    return {
      project: group[0],
      items: group,
      currentBonus: group.reduce((sum, item) => sum + item.amount, 0),
      manager: managers[0] ?? null,
      team,
      support: supports[0] ?? null,
      overflowMembers: [...managers.slice(1), ...allTeam.slice(4), ...supports.slice(1)],
    };
  }).sort((a, b) => (a.project.projectCode ?? "").localeCompare(b.project.projectCode ?? ""));
}
