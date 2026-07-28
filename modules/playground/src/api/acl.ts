import { defineAcl } from '@moxxy/companion-sdk/server';
import '../contract/index.js';

/**
 * One capability for the whole test bench. It spawns real (read-only-fenced)
 * agent runs that cost tokens, so it follows the run-driving grants: admin and
 * maintainer, never business.
 */
export default defineAcl({
  permissions: [{ id: 'playground:run', title: 'Test agents, skills and pipelines in the playground' }],
  grants: {
    admin: '*',
    maintainer: ['playground:run'],
  },
});
