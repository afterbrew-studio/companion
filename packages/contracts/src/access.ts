import type { Permission } from './registries.js';

/**
 * `'public'` = no auth; `'any'` = any signed-in user; a non-empty array means
 * the caller must hold every listed capability (AND, never OR).
 */
export type RouteAccess = Permission | readonly [Permission, ...Permission[]] | 'public' | 'any';
