import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export type Db = Database.Database;
export type Row = Record<string, any>;

export function openDb(path: string): Db {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 3000');
  return db;
}

export function nextNumber(db: Db, table: string, prefix: string): string {
  const { c } = db.prepare(`select count(*) as c from ${table}`).get() as { c: number };
  return `${prefix}-${new Date().getFullYear()}-${String(c + 1).padStart(6, '0')}`;
}
