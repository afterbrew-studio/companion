import { defineManifest } from '@companion/core';

export default defineManifest({
  id: 'plan',
  title: 'Plan',
  version: '0.1.0',
  dependsOn: ['code', 'operate', 'workspace', 'core'],
});
