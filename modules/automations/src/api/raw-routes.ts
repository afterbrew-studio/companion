import { defineRawRoutes, rawRoute } from '@companion/core/server';
import '../contract/index.js';

/**
 * The GitHub webhook receiver — the one endpoint that must read the request's
 * exact bytes (its HMAC signature is computed over the raw body) and
 * authenticates itself (the signature IS the auth; there is no bearer). It's a
 * raw route, so it mounts and unmounts with this module: disable automations and
 * the path 503s on its own, with no special-case in the app shell.
 */
export default defineRawRoutes((ctx) => {
  const { automations } = ctx.services.get('automations');
  return [
    rawRoute({
      method: 'POST',
      path: '/webhooks/github/:owner/:name',
      handler: ({ params, headers, body }) =>
        automations.handleDelivery(`${params.owner}/${params.name}`, headers, body),
    }),
  ];
});
