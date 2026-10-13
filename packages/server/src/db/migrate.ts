import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import type { Db } from './index.js';

/** Folder with generated SQL migrations: packages/server/drizzle (both from src/db and from dist). */
export function migrationsFolder(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const serverRoot = path.basename(here) === 'db' ? path.resolve(here, '..', '..') : path.resolve(here, '..');
  return path.join(serverRoot, 'drizzle');
}

export function runMigrations(db: Db): void {
  migrate(db, { migrationsFolder: migrationsFolder() });
}
