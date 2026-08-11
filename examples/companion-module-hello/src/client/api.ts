import { post } from '@moxxy/companion-sdk/client';
import type { GreetingResponse } from '../contract/index.js';

export const greetingsApi = {
  greet: (name: string) => post<GreetingResponse>('/api/hello/greetings', { name }),
};
