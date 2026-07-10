import type { Automations } from './automations.js';
import type { Assistant } from './assistant.js';

/**
 * The reactor bundle other modules (and the app server) resolve via
 * `ctx.services.get('automations')`: the webhook receiver + schedule ticker
 * (`automations`) and AI Help (`assistant`). The app's HTTP server delivers
 * raw GitHub webhook POSTs through
 * `services.get('automations').automations.handleDelivery(repo, headers, rawBody)`
 * — HMAC over the exact bytes, so that path bypasses the JSON router.
 */
export class AutomationsService {
  constructor(
    readonly automations: Automations,
    readonly assistant: Assistant,
  ) {}
}
