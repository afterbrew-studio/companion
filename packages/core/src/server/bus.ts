import type { BusEvents } from '@moxxy/companion-contracts';

type Handler<K extends keyof BusEvents> = (payload: BusEvents[K]) => void;

/**
 * Server-internal typed event bus. Replaces the single hard-coded broadcast
 * forward-ref (run.changed → proposals): a producer `emit`s and any module
 * subscribes in `onEnable` / unsubscribes in `onDisable`, so cross-module
 * reactions live with — and toggle with — the reacting module.
 */
export class ServerBus {
  private readonly handlers = new Map<string, Set<(p: unknown) => void>>();

  on<K extends keyof BusEvents & string>(event: K, handler: Handler<K>): () => void {
    let set = this.handlers.get(event);
    if (!set) {
      set = new Set();
      this.handlers.set(event, set);
    }
    const h = handler as (p: unknown) => void;
    set.add(h);
    return () => {
      set?.delete(h);
    };
  }

  emit<K extends keyof BusEvents & string>(event: K, payload: BusEvents[K]): void {
    const set = this.handlers.get(event);
    if (!set) return;
    for (const h of [...set]) h(payload);
  }
}
