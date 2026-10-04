/**
 * WorldDO — one Durable Object per game world.
 *
 * Port of server/WorldManager.js + server/server.js connection handling.
 * The authoritative GameWorld (server/GameWorld.js) and Player (server/Player.js)
 * classes are reused unchanged — they only rely on WebSocket objects that
 * expose `send()`, `readyState` and `close()`, all of which the Durable Object
 * WebSocket server provides.
 *
 * WebSockets are accepted with the standard (non-hibernation) API so the 20Hz
 * tick loop in GameWorld keeps running while players are connected.
 */

import { DurableObject } from 'cloudflare:workers';
import { GameWorld } from '../server/GameWorld.js';
import { Player } from '../server/Player.js';
import { DoWorldDatabase } from './DoWorldDatabase.js';
import {
  JOINED, WORLD_STATE, PLAYER_JOINED, PLAYER_LEFT,
  PLAYER_STATES, RECONCILE,
  BLOCK_PLACED, BLOCK_REMOVED, BLOCK_REJECTED,
  CHAT, LEAVE,
} from '../shared/messages.js';
import { TERRAIN_STYLES, generateTerrainCubes } from '../client/world/TerrainGenerator.js';

// Generated-terrain size/height. Kept modest so first-join generation stays
// fast and the Durable Object SQLite storage stays small on the free tier.
const TERRAIN_SIZE = 48;
const TERRAIN_HEIGHT_SCALE = 14;
const TERRAIN_OCTAVES = 5;

export class WorldDO extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.ctx = ctx;
    this.env = env;

    this._worldId = ctx.id.name || 'default';
    this._db = new DoWorldDatabase(ctx.storage);

    /** @type {Map<WebSocket, Player>} */
    this._conns = new Map();

    // World style/seed for the lobby list and terrain regeneration.
    const meta = this._db.getWorldMeta(this._worldId);
    this._style = (meta && meta.style) || 'random';
    this._seed = (meta && meta.seed) || null;

    // Create the world with persistence temporarily disabled; edits are applied
    // AFTER terrain is regenerated below so tombstones work against it.
    this._world = new GameWorld(
      this._worldId,
      this._worldId,
      (id) => this._onEmpty(id),
      null,
    );

    // Regenerate terrain from the stored seed (deterministic), then apply edits.
    if (this._seed !== null) {
      const { cubes, spawn } = this._buildTerrain(this._style, this._seed);
      this._loadCubes(cubes);
      this._world.setSpawn(spawn.x, spawn.y, spawn.z);
    }
    this._world._db = this._db;
    this._world._loadPersistedBlocks();
  }

  /**
   * Load generated terrain cubes (tuples [x,y,z,r,g,b]) into the world.
   * @param {Array<[number,number,number,number,number,number]>} cubes
   */
  _loadCubes(cubes) {
    this._world.loadBlocksFromArray(
      cubes.map(([x, y, z, r, g, b]) => ({ x, y, z, r, g, b })),
    );
  }

  _lobby() {
    return this.env.LOBBY.get(this.env.LOBBY.idFromName('lobby'));
  }

  _onEmpty(_id) {
    // Keep the persisted metadata; the world row stays in the lobby list with
    // playerCount 0. The GameWorld stops its own tick loop.
    this._lobby().update(this._worldId, 0, this._world._cubes.size, this._style).catch(() => {});
  }

  // --- WebSocket entry ---

  async fetch(request) {
    const upgrade = request.headers.get('Upgrade');
    if (!upgrade || upgrade.toLowerCase() !== 'websocket') {
      return new Response(JSON.stringify(this._world.getInfo()), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    server.accept();
    this._onConnection(server);
    return new Response(null, { status: 101, webSocket: client });
  }

  _onConnection(ws) {
    ws.addEventListener('message', (event) => {
      let msg;
      try {
        msg = JSON.parse(event.data);
      } catch {
        return;
      }
      this._handleMessage(ws, msg);
    });

    ws.addEventListener('close', () => this._handleDisconnect(ws));
    ws.addEventListener('error', () => {});
  }

  // --- Message routing (ported from WorldManager) ---

  _handleMessage(ws, msg) {
    switch (msg.type) {
      case 'join':
        this._handleJoin(ws, msg.worldId, msg.nickname, msg.characterId, msg.style, msg.seed);
        break;

      case 'leave':
        this._handleDisconnect(ws);
        break;

      default:
        this._routeToWorld(ws, msg);
        break;
    }
  }

  _handleJoin(ws, worldId, nickname, characterId, style, seed) {
    if (!nickname || typeof nickname !== 'string') {
      this._sendTo(ws, { type: 'error', message: 'Invalid nickname' });
      return;
    }

    const cleanName = nickname.trim().slice(0, 20);
    if (!cleanName) {
      this._sendTo(ws, { type: 'error', message: 'Nickname cannot be empty' });
      return;
    }

    if (this._world.players.size >= 50) {
      this._sendTo(ws, { type: 'error', message: 'World is full (max 50 players)' });
      return;
    }

    // Idempotent world row.
    this._db.ensureWorld(this._worldId, this._worldId);

    // Brand-new world (no seed yet) → generate terrain from the requested
    // style/seed, or a random style/seed if not provided.
    if (this._seed === null) {
      this._generateTerrain(style, seed);
    }

    const player = new Player(ws, cleanName, characterId || 'classic');
    this._conns.set(ws, player);
    this._world.addPlayer(player);

    // Register (idempotent) and publish live counts + style to the lobby registry.
    this._lobby().register(this._worldId, this._worldId, this._style).then(() =>
      this._lobby().update(this._worldId, this._world.players.size, this._world._cubes.size, this._style)
    ).catch(() => {});
  }

  /**
   * Generate terrain cubes + spawn for a style/seed WITHOUT persisting.
   * @param {string} style
   * @param {number} seed
   * @returns {{cubes: Array, spawn: {x:number,y:number,z:number}}}
   */
  _buildTerrain(style, seed) {
    return generateTerrainCubes({
      size: TERRAIN_SIZE,
      heightScale: TERRAIN_HEIGHT_SCALE,
      seed,
      octaves: TERRAIN_OCTAVES,
      style,
    });
  }

  /**
   * Generate a procedural terrain world for a brand-new world.
   * Only the seed/style are persisted (1 row) — the blocks themselves are
   * regenerated deterministically on load, keeping free-tier write usage tiny.
   *
   * @param {string} [requestedStyle] - one of TERRAIN_STYLES
   * @param {string|number} [requestedSeed] - numeric seed for reproducibility
   */
  _generateTerrain(requestedStyle, requestedSeed) {
    const style = TERRAIN_STYLES.includes(requestedStyle)
      ? requestedStyle
      : TERRAIN_STYLES[Math.floor(Math.random() * TERRAIN_STYLES.length)];

    let seed = Math.floor(Math.random() * 100000);
    if (requestedSeed !== undefined && requestedSeed !== null && requestedSeed !== '') {
      const parsed = parseInt(requestedSeed, 10);
      if (!Number.isNaN(parsed)) seed = Math.abs(parsed) % 100000;
    }

    console.log(`[world ${this._worldId}] Generating ${style} terrain, seed=${seed}...`);

    const { cubes, spawn } = this._buildTerrain(style, seed);

    // Persist only the seed + style, inside a transaction.
    this.ctx.storage.transactionSync(() => {
      this._db.setWorldMeta(this._worldId, String(seed), style);
    });

    this._style = style;
    this._seed = String(seed);
    this._loadCubes(cubes);
    this._world.setSpawn(spawn.x, spawn.y, spawn.z);

    console.log(`[world ${this._worldId}] Generated ${cubes.length} block(s).`);
  }

  _handleDisconnect(ws) {
    const player = this._conns.get(ws);
    if (!player) return;
    this._conns.delete(ws);

    this._world.removePlayer(player);

    this._lobby()
      .update(this._worldId, this._world.players.size, this._world._cubes.size, this._style)
      .catch(() => {});
  }

  _routeToWorld(ws, msg) {
    const player = this._conns.get(ws);
    if (!player) return;

    const type = msg.type;

    if (type === 'playerState') {
      player.queueInput(
        msg.inputKeys || { w: false, a: false, s: false, d: false, space: false },
        typeof msg.rotationY === 'number' ? msg.rotationY : 0,
        typeof msg.delta === 'number' ? msg.delta : 0.05,
        typeof msg.seq === 'number' ? msg.seq : 0,
      );

    } else if (type === 'placeBlock') {
      const result = this._world.placeBlock(
        msg.x, msg.y, msg.z,
        typeof msg.r === 'number' ? msg.r : Math.random(),
        typeof msg.g === 'number' ? msg.g : Math.random(),
        typeof msg.b === 'number' ? msg.b : Math.random(),
      );
      if (!result.ok) {
        this._sendTo(ws, { type: 'blockRejected', x: msg.x, y: msg.y, z: msg.z, reason: result.reason });
      }

    } else if (type === 'removeBlock') {
      const result = this._world.removeBlock(msg.x, msg.y, msg.z);
      if (!result.ok) {
        this._sendTo(ws, { type: 'blockRejected', x: msg.x, y: msg.y, z: msg.z, reason: result.reason });
      }

    } else if (type === 'chat') {
      if (msg.text && typeof msg.text === 'string' && msg.text.trim()) {
        this._world.broadcastChat(player, msg.text.trim().slice(0, 200));
      }
    }
  }

  _sendTo(ws, msg) {
    if (ws.readyState === 1) {
      ws.send(JSON.stringify(msg));
    }
  }

  // --- RPC methods used by the Worker ---

  async deleteWorld() {
    this._db.deleteWorld(this._worldId);
    this._world.destroy();
    this._conns.clear();
    await this._lobby().remove(this._worldId);
  }

  async info() {
    return this._world.getInfo();
  }
}
