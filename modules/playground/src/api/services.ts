import { defineServices } from '@moxxy/companion-sdk/server';

/**
 * Registers no service of its own — only the playground's run-task descriptor,
 * so the runner task filter can name its one-shots.
 */
export default defineServices((ctx) => {
  ctx.services
    .get('operate')
    .registerRunTask({ id: 'playground.run', label: 'Playground & dry-runs', placeable: false });
});
