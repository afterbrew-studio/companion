import { defineAcl } from '@moxxy/companion-sdk/server';
import '../contract/index.js';

export default defineAcl({
  permissions: [{ id: 'hello:greet', title: 'Send a greeting' }],
  grants: {
    admin: ['hello:greet'],
    maintainer: ['hello:greet'],
    business: ['hello:greet'],
  },
});
