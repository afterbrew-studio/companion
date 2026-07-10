import { defineManifest } from '@companion/core';

/**
 * module-core (required) — identity/auth/sessions/users + the settings service.
 * The always-on base; cannot be disabled. Provides the authenticator the kernel
 * wires into the router.
 */
export default defineManifest({
  id: 'core',
  title: 'Core',
  version: '0.1.0',
  required: true,
  permissions: ['users:manage', 'settings:manage'],
});
