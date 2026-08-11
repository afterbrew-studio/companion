import { defineClientRoutes, page } from '@moxxy/companion-sdk/client';

export const routes = defineClientRoutes([
  {
    match: { prefix: '/hello' },
    permission: 'hello:greet',
    component: page(() => import('./pages/greetings.js').then((m) => m.GreetingsPage)),
  },
]);
