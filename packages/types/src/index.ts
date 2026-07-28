/**
 * `@companion/types` — inert primitives with zero runtime cost and no domain
 * owner. The root of the workspace dependency graph. Nothing here crosses an
 * HTTP/WS boundary with meaning (that is `@moxxy/companion-contracts`) or belongs to
 * a single domain (that lives in a module's `contract/` slice).
 */
export * from './roles.js';
export * from './moxxy.js';
export * from './runner-agent.js';
