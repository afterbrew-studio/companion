import type { ReactNode } from 'react';
import type { Permission } from '@moxxy/companion-contracts';
import { useKernel } from './modules-provider.js';

/**
 * Render every enabled module's contribution to a named slot, RBAC-filtered.
 *
 * The shell's own extension points are named `shell.*`: `shell.banner` (a
 * full-width notice above the page), `shell.topbar` (the status cluster on the
 * right of the top bar) and `shell.effects` (components that render nothing and
 * exist to run a module's shell-level effect). A module attaches to them the
 * same way it attaches to another module's page, which is what keeps the shell
 * free of module imports.
 */
export function Slot({
  name,
  can,
  props,
  fallback,
}: {
  name: string;
  can: (p: Permission) => boolean;
  /**
   * Passed to every contribution. For what the HOST knows and the contributor
   * cannot, such as the sidebar being collapsed; never for data a module could
   * fetch itself, which would make the slot a coupling instead of an
   * extension point.
   */
  props?: Record<string, unknown>;
  /**
   * What the host draws when nothing is contributed, so a slot can carry an
   * optional embellishment (a provider's logo over its initials) instead of
   * only appending to what is already there.
   */
  fallback?: ReactNode;
}): ReactNode {
  const kernel = useKernel();
  const visible = kernel.slots(name).filter((s) => !s.permission || can(s.permission));
  if (visible.length === 0) return fallback ?? null;
  return visible.map((s) => <s.component key={s.key} {...props} />);
}
