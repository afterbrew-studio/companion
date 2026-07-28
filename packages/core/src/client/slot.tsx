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
export function Slot({ name, can }: { name: string; can: (p: Permission) => boolean }): ReactNode {
  const kernel = useKernel();
  return kernel.slots(name).map((s) => (s.permission && !can(s.permission) ? null : <s.component key={s.key} />));
}
