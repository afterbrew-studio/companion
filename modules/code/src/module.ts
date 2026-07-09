import { defineManifest } from '@companion/core';

export default defineManifest({
  id: 'code',
  title: 'Code',
  version: '0.1.0',
  dependsOn: ['operate', 'workspace', 'core'],
});
