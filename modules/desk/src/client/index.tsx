import '../contract/index.js';
import { defineClientModule } from '@moxxy/companion-sdk/client';
import manifest from '../module.js';

export { deskApi } from './api.js';
export { useMissions, type UseMissions } from './hooks/useMissions.js';
export { DeskRoot } from './components/DeskRoot.js';

export default defineClientModule({ manifest });
