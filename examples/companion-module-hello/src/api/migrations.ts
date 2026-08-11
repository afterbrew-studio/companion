import { defineMigrations } from '@moxxy/companion-sdk/server';

export default defineMigrations([
  {
    version: 1,
    name: 'hello_init',
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS hello_greetings (
          id         INTEGER PRIMARY KEY,
          name       TEXT NOT NULL,
          created_at INTEGER NOT NULL
        )
      `);
    },
    // Uninstall walks down() to zero, so `remove` leaves the database clean.
    down: (db) => {
      db.exec(`DROP TABLE IF EXISTS hello_greetings`);
    },
  },
]);
