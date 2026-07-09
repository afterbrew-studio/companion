/**
 * `@companion/core` (root) — the isomorphic surface: the module metafile
 * (`ModuleManifest` / `defineManifest`) shared by a module's `/api` and
 * `/client` slices. Server-only runtime is `@companion/core/server`; the web
 * host + client registrants are `@companion/core/client`.
 */
export * from './manifest.js';
