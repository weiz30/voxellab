/**
 * Durable Object SQLite adapter for world persistence.
 *
 * Drop-in replacement for server/WorldDatabase.js exposing the same
 * synchronous method surface (ensureWorld, saveBlock, removeBlock,
 * loadWorldBlocks, getPersistedWorlds, deleteWorld) but backed by the
 * Durable Object SQLite storage API instead of better-sqlite3.
 */

export class DoWorldDatabase {
  /**
   * @param {DurableObjectStorage} storage - ctx.storage from the Durable Object
   */
  constructor(storage) {
    this._sql = storage.sql;
    this._migrate();
  }

  _migrate() {
    this._sql.exec(`
      CREATE TABLE IF NOT EXISTS worlds (
        id            TEXT PRIMARY KEY,
        name          TEXT NOT NULL,
        seed          TEXT,
        style         TEXT,
        created_at    INTEGER NOT NULL,
        last_accessed INTEGER NOT NULL
      );
    `);

    // Add columns on pre-existing databases (idempotent).
    const cols = [...this._sql.exec('PRAGMA table_info(worlds)')].map((c) => c.name);
    if (!cols.includes('seed')) {
      this._sql.exec('ALTER TABLE worlds ADD COLUMN seed TEXT');
    }
    if (!cols.includes('style')) {
      this._sql.exec('ALTER TABLE worlds ADD COLUMN style TEXT');
    }

    this._sql.exec(`
      CREATE TABLE IF NOT EXISTS blocks (
        world_id  TEXT NOT NULL,
        x         REAL NOT NULL,
        y         REAL NOT NULL,
        z         REAL NOT NULL,
        r         REAL NOT NULL,
        g         REAL NOT NULL,
        b         REAL NOT NULL,
        removed   INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (world_id, x, y, z)
      );
    `);

    const bcols = [...this._sql.exec('PRAGMA table_info(blocks)')].map((c) => c.name);
    if (!bcols.includes('removed')) {
      this._sql.exec('ALTER TABLE blocks ADD COLUMN removed INTEGER NOT NULL DEFAULT 0');
    }
  }

  ensureWorld(id, name) {
    const now = Date.now();
    this._sql.exec(
      'INSERT OR IGNORE INTO worlds (id, name, created_at, last_accessed) VALUES (?, ?, ?, ?)',
      id, name, now, now,
    );
    this._sql.exec('UPDATE worlds SET last_accessed = ? WHERE id = ?', now, id);
  }

  getWorldMeta(worldId) {
    const rows = [...this._sql.exec(
      'SELECT seed, style FROM worlds WHERE id = ?',
      worldId,
    )];
    return rows.length ? { seed: rows[0].seed, style: rows[0].style } : null;
  }

  setWorldMeta(worldId, seed, style) {
    this._sql.exec(
      'UPDATE worlds SET seed = ?, style = ? WHERE id = ?',
      seed, style, worldId,
    );
  }

  saveBlock(worldId, x, y, z, r, g, b) {
    this._sql.exec(
      'INSERT OR REPLACE INTO blocks (world_id, x, y, z, r, g, b, removed) VALUES (?, ?, ?, ?, ?, ?, ?, 0)',
      worldId, x, y, z, r, g, b,
    );
  }

  removeBlock(worldId, x, y, z, r = 0, g = 0, b = 0) {
    // Store a tombstone so generated terrain blocks that are removed stay
    // removed when the terrain is regenerated from its seed.
    this._sql.exec(
      'INSERT OR REPLACE INTO blocks (world_id, x, y, z, r, g, b, removed) VALUES (?, ?, ?, ?, ?, ?, ?, 1)',
      worldId, x, y, z, r, g, b,
    );
  }

  loadWorldBlocks(worldId) {
    return [...this._sql.exec(
      'SELECT x, y, z, r, g, b, removed FROM blocks WHERE world_id = ?',
      worldId,
    )];
  }

  getPersistedWorlds() {
    return [...this._sql.exec(`
      SELECT
        w.id,
        w.name,
        w.last_accessed,
        (SELECT COUNT(*) FROM blocks WHERE world_id = w.id) AS blockCount
      FROM worlds w
      ORDER BY w.last_accessed DESC
    `)];
  }

  deleteWorld(worldId) {
    this._sql.exec('DELETE FROM blocks WHERE world_id = ?', worldId);
    this._sql.exec('DELETE FROM worlds WHERE id = ?', worldId);
  }

  close() {
    // Durable Object storage is managed by the runtime.
  }
}
