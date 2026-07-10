import type { ServiceMap } from '@companion/contracts';

/**
 * Typed cross-module service locator (replaces the flat `ApiDeps` god-object).
 * A module registers the service it provides; consumers `get()` a dependency's
 * service (guaranteed present across a `dependsOn` edge) or `tryGet()` a soft
 * one. A disabled module's keys are absent — presence is runtime-checked.
 *
 * Ownership: the kernel calls `setActiveModule(id)` around a module's
 * `registerServices`, so every key it registers is attributed to it and
 * `revokeModule(id)` can drop them ALL on disable (a module may register more
 * than one key, e.g. workspace → workspace/notifications/reports).
 */
export class ServiceRegistry {
  private readonly services = new Map<string, unknown>();
  private readonly owners = new Map<string, string>();
  private activeModule: string | null = null;

  /** Attribute subsequent registrations to `id` (or clear with null). Kernel-only. */
  setActiveModule(id: string | null): void {
    this.activeModule = id;
  }

  register<K extends keyof ServiceMap & string>(key: K, service: ServiceMap[K]): void {
    this.services.set(key, service);
    if (this.activeModule) this.owners.set(key, this.activeModule);
  }

  get<K extends keyof ServiceMap & string>(key: K): ServiceMap[K] {
    const s = this.services.get(key);
    if (s === undefined) {
      throw new Error(`service '${key}' not available (its module is disabled or not a declared dependency)`);
    }
    return s as ServiceMap[K];
  }

  tryGet<K extends keyof ServiceMap & string>(key: K): ServiceMap[K] | undefined {
    return this.services.get(key) as ServiceMap[K] | undefined;
  }

  /** Untyped accessor for the kernel's own bootstrapping (notify/settings proxies). */
  raw(key: string): unknown {
    return this.services.get(key);
  }

  /** Remove every service a module registered (all its keys). */
  revokeModule(moduleId: string): void {
    for (const [key, owner] of [...this.owners]) {
      if (owner === moduleId) {
        this.services.delete(key);
        this.owners.delete(key);
      }
    }
    // Belt-and-braces for the id-keyed convention if ownership wasn't recorded.
    this.services.delete(moduleId);
  }
}
