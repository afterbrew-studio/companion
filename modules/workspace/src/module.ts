import { defineManifest } from '@companion/core';

export default defineManifest({
  id: 'workspace',
  title: 'Workspace',
  version: '0.1.0',
  required: true,
  dependsOn: ['core'],
});
