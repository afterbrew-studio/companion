/**
 * `@companion/contracts` — the cross-boundary machinery: the open registries
 * modules augment (RBAC / WS / services / bus), the boot-time RBAC assembler,
 * and the kernel-level envelopes the framework itself needs. Domain DTOs do NOT
 * live here — they belong to each module's `contract/` slice.
 */
export * from './registries.js';
export * from './access.js';
export * from './rbac.js';
export * from './auth.js';
