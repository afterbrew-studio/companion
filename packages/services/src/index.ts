/**
 * `@moxxy/companion-services` — kernel-independent building blocks a single service
 * or store is made of: logging, request-scoped user context, tolerant model
 * JSON extraction, and shared SQL/JSON helpers. NOT the framework (that is
 * `@moxxy/companion-core`) and NOT concrete domain services (those live in modules).
 */
export * from './lib/log.js';
export * from './lib/model-json.js';
export * from './http/request-context.js';
export * from './http/outbound.js';
export * from './store/util.js';
export * from './config.js';
export * from './license.js';
export * from './instance-lock.js';
