import { defineRoutes, route } from '@moxxy/companion-sdk/server';
import { z } from 'zod';
import type { GreetingResponse } from '../contract/index.js';
import { GreetingStore } from './greeting-store.js';

export default defineRoutes((ctx) => {
  const store = new GreetingStore(ctx.db);
  return [
    route({
      method: 'POST',
      path: '/api/hello/greetings',
      access: 'hello:greet',
      body: z.object({ name: z.string().trim().min(1).max(80) }),
      handler: ({ body }): GreetingResponse => {
        store.record(body.name);
        return { message: `Welcome to Companion, ${body.name}!`, total: store.total() };
      },
    }),
  ];
});
