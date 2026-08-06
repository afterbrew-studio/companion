import { defineAcl } from '@moxxy/companion-sdk/server';
import '../contract/index.js';

/**
 * Connection management belongs to module-integrations. Notify owns only the
 * bounded delivery history, which operators and maintainers use to diagnose a
 * destination that stopped receiving events.
 */
export default defineAcl({
  permissions: [
    { id: 'notify:read', title: 'View outbound notification delivery history' },
  ],
  grants: {
    admin: ['notify:read'],
    maintainer: ['notify:read'],
  },
});
