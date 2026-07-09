import type { Permission } from './registries.js';

/** `'public'` = no auth; `'any'` = any signed-in user; otherwise a capability. */
export type RouteAccess = Permission | 'public' | 'any';
