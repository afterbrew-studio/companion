import { defineManifest } from '@moxxy/companion-sdk';

export default defineManifest({
  id: 'cursor-bugbot',
  title: 'Cursor Bugbot',
  version: '0.1.0',
  dependsOn: ['integrations'],
  // Opt-in: a delegated review posts a real PR comment and nothing tracks its
  // completion yet, so the module lands as Available even in the full profile.
  autoInstall: false,
});
