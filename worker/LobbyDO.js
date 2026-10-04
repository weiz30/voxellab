/**
 * LobbyDO — single global registry of known worlds.
 *
 * WorldDO instances register themselves here and push live player/block
 * counts. The Worker reads this for `GET /api/worlds` and `DELETE /api/worlds/:id`.
 *
 * Backed by Durable Object SQLite storage so the list survives restarts.
 */

import { DurableObject } from 'cloudflare:workers';

export class LobbyDO extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS worlds (
        id           TEXT PRIMARY KEY,
        name         TEXT NOT NULL,
        style        TEXT,
        playerCount  INTEGER NOT NULL DEFAULT 0,
        blockCount   INTEGER NOT NULL DEFAULT 0,
        lastAccessed INTEGER NOT NULL DEFAULT 0
      );
    `);

    const cols = [...ctx.storage.sql.exec('PRAGMA table_info(worlds)')].map((c) => c.name);
    if (!cols.includes('style')) {
      ctx.storage.sql.exec('ALTER TABLE worlds ADD COLUMN style TEXT');
    }
  }

  async register(id, name, style) {
    this.ctx.storage.sql.exec(
      'INSERT OR IGNORE INTO worlds (id, name, style, lastAccessed) VALUES (?, ?, ?, ?)',
      id, name, style || 'random', Date.now(),
    );
  }

  async update(id, playerCount, blockCount, style) {
    this.ctx.storage.sql.exec(
      'UPDATE worlds SET playerCount = ?, blockCount = ?, style = ?, lastAccessed = ? WHERE id = ?',
      playerCount, blockCount, style || 'random', Date.now(), id,
    );
  }

  async list() {
    return [...this.ctx.storage.sql.exec(
      'SELECT id, name, style, playerCount, blockCount FROM worlds ORDER BY lastAccessed DESC',
    )];
  }

  async remove(id) {
    this.ctx.storage.sql.exec('DELETE FROM worlds WHERE id = ?', id);
  }
}
