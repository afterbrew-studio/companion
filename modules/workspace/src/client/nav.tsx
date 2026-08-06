import { defineNav, defineQuickActions, defineSections } from '@moxxy/companion-sdk/client';

/**
 * module-workspace owns Home and the non-sidebar specialist-tool catalog.
 * Everyday domains attach their own focused groups; everything else remains
 * searchable without becoming a permanent menu row.
 */

export const sections = defineSections([
  { id: 'workspace', label: 'Home', order: 10 },
  { id: 'more', label: 'Tools', order: 90, placement: 'catalog' },
]);

export const nav = defineNav([]);

export const actions = defineQuickActions([
  {
    key: 'new-workspace',
    label: 'Create workspace',
    group: 'Create',
    access: ['workspaces:create'],
    keywords: 'new add workspace group private public',
    order: 80,
    intent: 'new-workspace',
  },
]);
