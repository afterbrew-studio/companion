import { defineManifest } from '@companion/core';

/**
 * module-core (required) — identity/auth/sessions/users, the settings + inbox
 * infrastructure, and the Modules admin. The always-on base; cannot be disabled.
 */
export default defineManifest({
  id: 'core',
  title: 'Core',
  version: '0.1.0',
  required: true,
  permissions: ['users:manage', 'settings:manage'],
  messages: ['notifications.changed'],
});
