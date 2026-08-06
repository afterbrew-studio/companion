import type { ClientIntent, Permission } from '@moxxy/companion-contracts';
import { runIntent } from './intents.js';

interface QuickActionBase {
  readonly key: string;
  readonly label: string;
  readonly group: 'Create' | 'Connect' | 'Help';
  readonly access: readonly [Permission, ...Permission[]];
  readonly keywords?: string;
  readonly order?: number;
}

/** A natural user outcome contributed by its owning module, not hard-coded in the shell. */
export type QuickAction = QuickActionBase & (
  | { readonly intent: ClientIntent; readonly hash?: never }
  | { readonly hash: string; readonly intent?: never }
);

export const defineQuickActions = (actions: readonly QuickAction[]): readonly QuickAction[] => actions;

export function canUseQuickAction(action: QuickAction, can: (permission: Permission) => boolean): boolean {
  return action.access.every(can);
}

export function runQuickAction(action: QuickAction): void {
  if (action.intent) runIntent(action.intent);
  else location.hash = action.hash;
}
