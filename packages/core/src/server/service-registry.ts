import type { ServiceMap } from '@companion/contracts';

/**
 * Typed cross-module service locator (replaces the flat `ApiDeps` god-object).
 * A module registers the service it provides; consumers `get()` a dependency's
 * service (guaranteed present across a `dependsOn` edge) or `tryGet()` a soft
 * one. A disabled module's key is absent — presence is runtime-checked.
 */
export class ServiceRegistry {
  private readonly services = new Map<string, unknown>();

  register<K extends keyof ServiceMap & string>(key: K, service: ServiceMap[K]): void {
    this.services.set(key, service);
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

  revoke(key: string): void {
    this.services.delete(key);
  }
}
