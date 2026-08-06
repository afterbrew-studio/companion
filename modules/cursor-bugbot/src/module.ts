import { defineManifest } from '@moxxy/companion-sdk';

export default defineManifest({
  id: 'cursor-bugbot',
  title: 'Cursor Bugbot',
  version: '0.1.0',
  dependsOn: ['integrations'],
  // Registration has no GitHub side effect; creating a connection is the
  // explicit opt-in, and running a review is the explicit delegated write.
  autoInstall: true,
});
