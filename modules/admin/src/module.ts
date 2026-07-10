import { defineManifest } from '@companion/core';

/**
 * module-admin — the thin instance-administration surface over core-owned
 * settings (branding, the notification default scope). It owns no tables and
 * declares no new permissions; its routes reuse `settings:manage` from
 * module-core, hence `dependsOn: ['core']`.
 */
export default defineManifest({
  id: 'admin',
  title: 'Admin',
  version: '0.1.0',
  dependsOn: ['core'],
});
