// Brings core's + workspace's + operate's + code's + plan's augmentations
// (automations dependsOn all five — it sits at the top of the module graph).
import '@companion/module-core/contract';
import '@companion/module-workspace/contract';
import '@companion/module-operate/contract';
import '@companion/module-code/contract';
import '@companion/module-plan/contract';
import type { AutomationsService } from '../api/automations-service.js';

/**
 * module-automations contract slice — the reactor module: the GitHub webhook
 * receiver, the slow schedule ticker (digests, stale sweeps, briefings,
 * auto-merge) and AI Help (the platform-operating assistant).
 *
 * No DTOs live here: everything this module's routes speak is owned elsewhere —
 * `WebhookInfo` + `BriefingCadence` by module-code's contract,
 * `WebhookTunnelState` by module-operate's — and it broadcasts only existing
 * WS tags (`repos.changed`, `reports.changed`; notifications go via ctx.notify).
 */

declare module '@moxxy/companion-contracts' {
  interface PermissionRegistry {
    'automations:manage': true;
  }
  interface ServiceMap {
    /** The reactor bundle: webhook receiver + schedule ticker (`automations`) and AI Help (`assistant`). */
    automations: AutomationsService;
  }
}
