import { defineManifest } from '@moxxy/companion-sdk';

/**
 * module-oidc: sign in through an OpenID Connect provider (Okta, Entra ID,
 * Auth0, Google, Keycloak).
 *
 * This is the reference identity module: it owns the protocol end to end and
 * touches nothing else. It registers a provider with module-core in `onEnable`,
 * serves the two public routes the handshake needs, and hands the verified
 * identity to `signInExternal`, which mints an ordinary Companion session.
 * Token verification on every request stays core's job, so this adds nothing to
 * the per-request path.
 *
 * SAML is deliberately absent: it needs XML signature verification, which means
 * a dependency and a far larger attack surface. Use OIDC where the provider
 * offers both, which all of the above do.
 */
export default defineManifest({
  id: 'oidc',
  title: 'OIDC Sign-in',
  version: '0.1.0',
  dependsOn: ['core'],
  // Identity is never something an instance should acquire by accident.
  autoInstall: false,
  config: [
    {
      key: 'issuer',
      label: 'Issuer URL',
      description: "The provider's base URL; its /.well-known/openid-configuration is read from here.",
      kind: 'text',
      required: true,
      // TLS in production, loopback allowed because every local IdP (Keycloak
      // in a container, a test provider) serves plain http on 127.0.0.1.
      pattern: '^(https://|http://(127\\.0\\.0\\.1|localhost)(:\\d+)?(/|$))',
      placeholder: 'https://example.okta.com',
    },
    { key: 'clientId', label: 'Client ID', kind: 'text', required: true, max: 200 },
    { key: 'clientSecret', label: 'Client secret', kind: 'secret', required: true },
    {
      key: 'label',
      label: 'Button label',
      description: 'Shown on the sign-in page.',
      kind: 'text',
      default: 'Sign in with SSO',
      max: 60,
    },
    {
      key: 'usernameClaim',
      label: 'Username claim',
      description: 'Which claim becomes the Companion username.',
      kind: 'select',
      default: 'preferred_username',
      options: [
        { value: 'preferred_username', label: 'preferred_username' },
        { value: 'email', label: 'email' },
        { value: 'sub', label: 'sub (opaque but stable)' },
      ],
    },
    { key: 'scopes', label: 'Scopes', kind: 'text', default: 'openid profile email', max: 200 },
  ],
});
