// Side-effect import: pulls operate's (and core's/workspace's) ServiceMap
// augmentations into the program so `ServiceMap['operate']` resolves.
import '../contract/index.js';
import type { ServiceMap } from '@moxxy/companion-contracts';

/**
 * Local aliases for the execution-plane types this module consumes. Another
 * module's `/api` entry must never be imported, so instead of importing
 * operate's classes the aliases are derived structurally from the `operate`
 * service bundle (`ctx.services.get('operate')`) — the instances the moved
 * bodies receive are exactly those, so assignability is a given.
 */
export type OperateService = ServiceMap['operate'];
export type Orchestrator = OperateService['orchestrator'];
export type Checkouts = OperateService['checkouts'];
export type RunsStore = OperateService['runsStore'];
export type RunnerBackend = ReturnType<Orchestrator['runners']['backend']>;
