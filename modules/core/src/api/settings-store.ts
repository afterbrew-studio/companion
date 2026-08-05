import type { Database } from '@moxxy/companion-services';
import type {
  NavigationAudience,
  NavigationPageOverride,
  NavigationPerspective,
} from '@moxxy/companion-contracts';
import type { NotificationScope } from '../contract/index.js';

/** Instance-wide key/value settings (the core-owned `settings` table). */
export class SettingsStore {
  constructor(private readonly db: Database) {}

  get(key: string): string | null {
    const row = this.db.prepare(`SELECT value FROM settings WHERE key = ?`).get(key) as { value: string } | undefined;
    return row?.value ?? null;
  }

  set(key: string, value: string): void {
    this.db
      .prepare(`INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
      .run(key, value);
  }

  delete(key: string): void {
    this.db.prepare(`DELETE FROM settings WHERE key = ?`).run(key);
  }

  // ---------- notification scope preferences ----------------------------------
  // All key names live here so scope resolution has a single source of truth.

  notificationDefaultScope(): NotificationScope {
    return this.get('notifications.defaultScope') === 'global' ? 'global' : 'workspace';
  }

  setNotificationDefaultScope(scope: NotificationScope): void {
    this.set('notifications.defaultScope', scope);
  }

  userNotificationScope(username: string): NotificationScope | null {
    const raw = this.get(`notifications.scope:${username}`);
    return raw === 'global' || raw === 'workspace' ? raw : null;
  }

  setUserNotificationScope(username: string, scope: NotificationScope | null): void {
    this.set(`notifications.scope:${username}`, scope ?? '');
  }

  resolveNotificationScope(username: string): NotificationScope {
    return this.userNotificationScope(username) ?? this.notificationDefaultScope();
  }

  // ---------- sidebar personalisation -----------------------------------------

  /** Personal deviations from the module-authored defaults of each menu view.
   * Stale module keys are harmless and bounded; RBAC remains authoritative. */
  userNavOverrides(username: string): readonly NavigationPageOverride[] {
    const raw = this.get(`nav.overrides:${username}`);
    if (!raw) {
      // Compatibility with the first navigation prototype: a globally hidden
      // page remains hidden in every view until the user resets/customises one.
      const legacy = this.legacyHiddenNav(username);
      const perspectives: readonly NavigationAudience[] = ['business', 'developer', 'admin'];
      return perspectives.flatMap((perspective) =>
        legacy.map((key) => ({ perspective, key, visible: false })),
      );
    }
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      const unique = new Map<string, NavigationPageOverride>();
      for (const item of parsed.slice(0, 600)) {
        if (!isNavigationPageOverride(item)) continue;
        unique.set(`${item.perspective}\u0000${item.key}`, item);
      }
      return [...unique.values()];
    } catch {
      return [];
    }
  }

  setUserNavOverrides(username: string, overrides: readonly NavigationPageOverride[]): void {
    const unique = new Map<string, NavigationPageOverride>();
    for (const override of overrides) unique.set(`${override.perspective}\u0000${override.key}`, override);
    this.set(`nav.overrides:${username}`, JSON.stringify([...unique.values()]));
    this.delete(`nav.hidden:${username}`);
  }

  userNavPerspective(username: string): NavigationPerspective {
    const value = this.get(`nav.perspective:${username}`);
    return value === 'business' || value === 'developer' || value === 'admin' ? value : 'auto';
  }

  setUserNavPerspective(username: string, perspective: NavigationPerspective): void {
    this.set(`nav.perspective:${username}`, perspective);
  }

  private legacyHiddenNav(username: string): readonly string[] {
    const raw = this.get(`nav.hidden:${username}`);
    if (!raw) return [];
    try {
      const parsed: unknown = JSON.parse(raw);
      return Array.isArray(parsed)
        ? parsed.filter((key): key is string => typeof key === 'string' && key.length > 0 && key.length <= 64)
        : [];
    } catch {
      return [];
    }
  }
}

function isNavigationPageOverride(value: unknown): value is NavigationPageOverride {
  if (typeof value !== 'object' || value === null) return false;
  const item = value as Partial<NavigationPageOverride>;
  return (
    (item.perspective === 'business' || item.perspective === 'developer' || item.perspective === 'admin')
    && typeof item.key === 'string'
    && item.key.length > 0
    && item.key.length <= 64
    && typeof item.visible === 'boolean'
  );
}
