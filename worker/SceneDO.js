/**
 * SceneDO — storage for offline-mode scene save files.
 *
 * Replaces the Vite dev middleware (`/api/scenes`, `/api/save/:name`,
 * `/api/load/:name`) and the on-disk `public/scenes/*.scene` files with a
 * Durable Object SQLite table, so offline saves work on Cloudflare without
 * needing R2 or KV.
 */

import { DurableObject } from 'cloudflare:workers';

export class SceneDO extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS scenes (
        name TEXT PRIMARY KEY,
        data TEXT NOT NULL
      );
    `);
  }

  async list() {
    return [...this.ctx.storage.sql.exec('SELECT name FROM scenes ORDER BY name')]
      .map((row) => row.name);
  }

  async save(name, data) {
    this.ctx.storage.sql.exec(
      'INSERT OR REPLACE INTO scenes (name, data) VALUES (?, ?)',
      name, data,
    );
  }

  async load(name) {
    const rows = [...this.ctx.storage.sql.exec(
      'SELECT data FROM scenes WHERE name = ?',
      name,
    )];
    return rows.length ? rows[0].data : null;
  }
}
