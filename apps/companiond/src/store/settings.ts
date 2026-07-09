import type Database from 'better-sqlite3';
import type { NotificationScope } from '@companion/contract';

/** Instance-wide key/value settings. */
export class SettingsStore {
  constructor(private readonly db: Database.Database) {}

  get(key: string): string | null {
    const row = this.db.prepare(`SELECT value FROM settings WHERE key = ?`).get(key) as
      | { value: string }
      | undefined;
    return row?.value ?? null;
  }

  set(key: string, value: string): void {
    this.db
      .prepare(
        `INSERT INTO settings (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      )
      .run(key, value);
  }

  // ---------- notification scope preferences ----------------------------------
  // All key names live here so scope resolution has a single source of truth.

  /** Instance-wide inbox default; new installs are workspace-scoped. */
  notificationDefaultScope(): NotificationScope {
    return this.get('notifications.defaultScope') === 'global' ? 'global' : 'workspace';
  }

  setNotificationDefaultScope(scope: NotificationScope): void {
    this.set('notifications.defaultScope', scope);
  }

  /** A user's own override, or null when they inherit the instance default. */
  userNotificationScope(username: string): NotificationScope | null {
    const raw = this.get(`notifications.scope:${username}`);
    return raw === 'global' || raw === 'workspace' ? raw : null;
  }

  setUserNotificationScope(username: string, scope: NotificationScope | null): void {
    // Store the empty string as "inherit" — get() treats it as unset.
    this.set(`notifications.scope:${username}`, scope ?? '');
  }

  /** The scope actually applied for a user: their override, else the default. */
  resolveNotificationScope(username: string): NotificationScope {
    return this.userNotificationScope(username) ?? this.notificationDefaultScope();
  }
}
