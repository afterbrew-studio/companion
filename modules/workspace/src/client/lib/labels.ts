import type { WorkspaceRecord } from '../../contract/index.js';

/** True when another workspace shares this one's (trimmed, case-folded) name. */
export function isAmbiguousWorkspaceName(w: WorkspaceRecord, all: readonly WorkspaceRecord[]): boolean {
  const key = w.name.trim().toLowerCase();
  return all.some((o) => o.id !== w.id && o.name.trim().toLowerCase() === key);
}

/**
 * Display label for workspace pickers. Names are not unique — the slug is
 * (DB-enforced, stable across renames) — so a colliding name is qualified
 * with it: "Personal (personal-b2f4)". Plain string so <option> can carry it.
 */
export function workspaceLabel(w: WorkspaceRecord, all: readonly WorkspaceRecord[]): string {
  return isAmbiguousWorkspaceName(w, all) ? `${w.name} (${w.slug})` : w.name;
}
