/**
 * Coarse personas. Every fine-grained capability (`Permission`) is granted to
 * roles by the modules that own it; the effective grid is assembled at boot
 * from the enabled modules' ACL slices (see `@companion/contracts`).
 */
export type Role = 'admin' | 'maintainer' | 'business';

export const ROLES: readonly Role[] = ['admin', 'maintainer', 'business'];
