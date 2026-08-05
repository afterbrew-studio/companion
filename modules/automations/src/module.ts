import { defineManifest } from '@moxxy/companion-sdk';

/**
 * module-automations — the reactor module: drives the code/plan/operate domains
 * off external events (HMAC-verified GitHub webhooks) and schedules (daily
 * digests, stale sweeps, workspace briefings, the auto-merge sweep), plus AI
 * Help — the per-user assistant that operates the platform through its own
 * REST API. It sits at the top of the module graph, consuming every other
 * domain; in the SPA its policy page is presented as workspace configuration
 * while its digest contributes to Home (module ≠ sidebar group).
 */
export default defineManifest({
  id: 'automations',
  title: 'Automations',
  version: '0.1.0',
  dependsOn: ['plan', 'code', 'operate', 'workbench', 'workspace', 'core'],
  autoInstall: false,
  permissions: ['automations:manage'],
  messages: ['automations.changed'],
});
