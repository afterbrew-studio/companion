import { defineManifest } from '@moxxy/companion-sdk';

/** Companion Desk: the agent-first surface. It owns durable Missions while
 * every domain object and side effect remains with its existing module. */
export default defineManifest({
  id: 'desk',
  title: 'Companion Desk',
  version: '0.1.0',
  dependsOn: ['automations', 'code', 'operate', 'slop', 'workbench', 'workspace', 'core'],
  permissions: [],
  messages: ['desk.missions.changed'],
});
