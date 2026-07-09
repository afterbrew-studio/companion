import type { Proposals } from './proposals.js';
import type { Specs } from './specs.js';
import type { Docs } from './docs.js';

/**
 * The planning-domain bundle other modules resolve via
 * `ctx.services.get('plan')`: proposals, specifications and documentation.
 * automations consumes specs (drift detection); the assistant consumes docs
 * retrieval.
 */
export class PlanService {
  constructor(
    readonly proposals: Proposals,
    readonly specs: Specs,
    readonly docs: Docs,
  ) {}
}
