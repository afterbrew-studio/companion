import type { Database, ModuleContext } from '@moxxy/companion-sdk/server';
import { PlaygroundEvaluationStore } from './evaluation-store.js';
import { ProductionEvaluations } from './production-evaluations.js';

/** Module-owned durable evaluation stores and long-running production suite. */
export class PlaygroundService {
  readonly evaluations: PlaygroundEvaluationStore;
  readonly production: ProductionEvaluations;

  constructor(db: Database, ctx: ModuleContext) {
    this.evaluations = new PlaygroundEvaluationStore(db);
    this.production = new ProductionEvaluations({
      store: this.evaluations,
      operate: ctx.services.get('operate'),
      isEnabled: ctx.isEnabled,
      broadcast: () => ctx.broadcast({ t: 'playground.changed' }),
      log: (message, detail) => ctx.log.warn(message, detail),
    });
  }
}
