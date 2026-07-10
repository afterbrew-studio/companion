import { defineClientModule } from '@companion/core/client';
import manifest from '../module.js';
import { nav, sections } from './nav.js';
import { routes } from './routes.js';

/**
 * The `/client` barrel — module-plan's web surface: the Plan sidebar group +
 * proposals/specs/docs routes, plus the api and data hooks downstream modules
 * (automations' Digest relocation) reach by name.
 */

export { planApi } from './api.js';
export { useProposals } from './hooks/useProposals.js';
export { useSpecs } from './hooks/useSpecs.js';
export { useDocs } from './hooks/useDocs.js';

export default defineClientModule({
  manifest,
  sections,
  nav,
  routes,
});
