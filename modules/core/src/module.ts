import { defineManifest } from '@moxxy/companion-core';

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
  permissions: ['users:manage', 'settings:manage', 'modules:manage', 'modules:deploy', 'audit:read'],
  config: [
    {
      key: 'externalSignup',
      label: 'Create accounts on first SSO sign-in',
      description: 'Off by default: an identity provider misconfiguration should lock people out, not hand out accounts.',
      kind: 'boolean',
      default: false,
    },
    {
      key: 'externalSignupRole',
      label: 'Role for accounts created this way',
      description: 'Must be a role that cannot manage users. Provisioning into a user-managing role is refused.',
      kind: 'text',
      default: 'business',
      max: 40,
    },
    {
      key: 'auditRetentionDays',
      label: 'Audit retention (days)',
      description: 'Entries older than this are swept daily. Export before shortening it.',
      kind: 'number',
      default: 365,
      min: 7,
      max: 3650,
    },
  ],
});
