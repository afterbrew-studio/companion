import { defineAcl } from '@moxxy/companion-sdk/server';
import '../contract/index.js';

/**
 * Reading which destinations exist is operational awareness a maintainer needs
 * ("why did nobody hear about this?"); creating one means handing the instance
 * a credential that posts into a third party, which is administration.
 */
export default defineAcl({
  permissions: [
    { id: 'notify:read', title: 'View outbound notification channels' },
    { id: 'notify:manage', title: 'Configure outbound notification channels' },
    { id: 'notify:self', title: 'Send your own notifications to a channel you own' },
  ],
  grants: {
    admin: '*',
    maintainer: ['notify:read', 'notify:self'],
    // Same shape as runners:connect: anyone may wire up their OWN destination
    // without being able to touch a shared one.
    business: ['notify:self'],
  },
});
