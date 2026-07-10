import { defineClientModule } from '@companion/core/client';
import manifest from '../module.js';

export * from './widgets.js';

export default defineClientModule({
  manifest,
});
