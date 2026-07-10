import type Database from 'better-sqlite3';
import type { NotificationScope } from '../contract/index.js';

/** Instance-wide key/value settings (the core-owned `settings` table). */
export class SettingsStore {
  constructor(private readonly db: Database.Database) {}

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
}
