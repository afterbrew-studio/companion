import { defineNav, defineSections } from '@companion/core/client';

/**
 * module-workspace owns the Workspace sidebar group but contributes no entries
 * of its own — Overview ships with module-code and Daily Digest with
 * module-automations (the module that generates the digests); both attach to
 * this section by id.
 */

export const sections = defineSections([{ id: 'workspace', label: 'Workspace', order: 10 }]);

export const nav = defineNav([]);
