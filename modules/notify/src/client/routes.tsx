import { defineClientRoutes, page } from '@moxxy/companion-sdk/client';

export const routes = defineClientRoutes([
  {
    match: { prefix: '/notify' },
    permission: 'notify:read',
    component: page(() => import('./pages/Channels.js').then((m) => m.ChannelsPage)),
  },
]);
