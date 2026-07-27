import { defineRoutes, route, Reply, badRequest, redirect } from '@moxxy-ai/companion-sdk/server';
import { OidcClient } from './oidc-client.js';
import '../contract/index.js';

/** Everything a login needs, read live so a config edit takes effect without a restart. */
function clientFor(ctx: Parameters<Parameters<typeof defineRoutes>[0]>[0]): OidcClient | null {
  const issuer = ctx.moduleConfig.get('issuer');
  const clientId = ctx.moduleConfig.get('clientId');
  const clientSecret = ctx.moduleConfig.get('clientSecret');
  if (typeof issuer !== 'string' || typeof clientId !== 'string' || typeof clientSecret !== 'string') return null;
  return new OidcClient(
    issuer,
    clientId,
    clientSecret,
    String(ctx.moduleConfig.get('scopes') ?? 'openid profile email'),
    String(ctx.moduleConfig.get('usernameClaim') ?? 'preferred_username'),
  );
}

/**
 * Both routes are `public` by necessity: they run before anyone has a session.
 * That is the whole reason the module verifies the handshake itself rather than
 * leaning on the router's RBAC, which has nothing to check yet.
 */
export default defineRoutes((ctx) => {
  // One client instance per activation, so PKCE verifiers survive between the
  // two requests of a single login.
  let cached: OidcClient | null = null;
  const client = (): OidcClient => {
    cached ??= clientFor(ctx);
    if (!cached) throw badRequest('OIDC is not configured: set the issuer, client id and secret on the Modules page');
    return cached;
  };
  const redirectUri = (): string => `${(ctx.config.publicUrl ?? '').replace(/\/+$/, '')}/api/oidc/callback`;

  const html = (body: string): Reply =>
    new Reply(200, `<!doctype html><meta charset="utf-8"><title>Sign-in</title><body>${body}`, 'text/html; charset=utf-8');

  return [
    route({
      method: 'GET',
      path: '/api/oidc/start',
      access: 'public',
      handler: async ({ query }) => {
        if (!ctx.config.publicUrl) {
          throw badRequest('COMPANION_PUBLIC_URL must be set: the provider redirects the browser back to it');
        }
        // Only same-origin paths, so the callback cannot be turned into an open
        // redirect by a crafted link to /start.
        const raw = query.get('returnTo') ?? '/';
        const returnTo = raw.startsWith('/') && !raw.startsWith('//') ? raw : '/';
        return redirect(await client().authorizeUrl(redirectUri(), returnTo));
      },
    }),

    route({
      method: 'GET',
      path: '/api/oidc/callback',
      access: 'public',
      handler: async ({ query }) => {
        const error = query.get('error');
        if (error) return html(`<p>Sign-in was refused by the provider: ${escapeHtml(error)}</p>`);
        const code = query.get('code');
        const state = query.get('state');
        if (!code || !state) throw badRequest('the provider returned no code');

        const { identity, returnTo } = await client().complete(code, state, redirectUri());
        const auth = ctx.services.get('core');
        // Policy lives in module-core, not here: an identity module must not
        // get to decide how generous provisioning is.
        const policy = ctx.modules.getConfig('core').values;
        const session = auth.signInExternal(identity, {
          provision: policy.externalSignup === true,
          role: typeof policy.externalSignupRole === 'string' && policy.externalSignupRole
            ? policy.externalSignupRole
            : 'business',
        });
        // The router audits mutating requests, but this one is a public GET, so
        // it records nothing. An external sign-in is exactly the event an
        // operator expects to find in the trail, so record it here.
        ctx.audit.record({
          at: Date.now(),
          actor: session.user.username,
          action: 'GET /api/oidc/callback',
          access: 'public',
          status: 200,
          module: 'oidc',
          detail: `signed in via ${ctx.moduleConfig.get('issuer') as string} as ${identity.username}`,
        });

        // The SPA reads its session from localStorage under this exact key
        // (`TOKEN_KEY` in @companion/core/client), so hand it over in a page it
        // controls rather than a cookie the app does not use.
        return html(
          `<script>localStorage.setItem('companion.session', ${JSON.stringify(session.token)});` +
            `location.replace(${JSON.stringify(returnTo)});</script>` +
            `<noscript>Signed in. <a href="${escapeHtml(returnTo)}">Continue</a>.</noscript>`,
        );
      },
    }),
  ];
});

const escapeHtml = (s: string): string =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
