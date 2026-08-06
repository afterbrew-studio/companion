import { defineManifest } from '@moxxy/companion-sdk';

export default defineManifest({
  id: 'coderabbit',
  title: 'CodeRabbit CLI',
  version: '0.1.0',
  dependsOn: ['integrations'],
  // Registration is inert until an operator creates a connection and routes
  // reviews to it, so the provider can be discoverable out of the box.
  autoInstall: true,
});
