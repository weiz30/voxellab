import { WorldMap } from '../shared/WorldMap.js';
import { simulateStep, doesBlockOverlapAnyPlayer, resolvePlayerOverlaps, resolveAnyOverlapOnWorld, checkPlayerGrounded, checkPlayerOnAnyPlayer } from '../shared/physics.js';
import {
  TICK_INTERVAL_MS,
  MAX_PLAYERS,
  MAX_DELTA,
  WORLD_DESTROY_TIMEOUT_MS,
  CHAR_HEIGHT,
} from '../shared/constants.js';
import {
  JOINED, WORLD_STATE, PLAYER_JOINED, PLAYER_LEFT,
  PLAYER_STATES, RECONCILE,
  BLOCK_PLACED, BLOCK_REMOVED, BLOCK_REJECTED,
  CHAT, LEAVE,
} from '../shared/messages.js';
import { Player } from './Player.js';

/**
 * An authoritative game world instance.
 *
 * Each GameWorld owns:
 * - A WorldMap (canonical block occupancy)
 * - A flat cube array for serialization (parallels WorldMap for fast iteration)
 * - A set of connected Players
 * - A 20Hz tick loop for processing inputs and broadcasting state
 *
 * Lifecycle: created on first join, destroyed after WORLD_DESTROY_TIMEOUT_MS
 * of being empty.
 */
export class GameWorld {
  /**
   * @param {string} worldId - Unique world identifier
   * @param {string} name - Display name
   * @param {function} onEmpty - Called when the world should be destroyed
   * @param {import('./WorldDatabase.js').WorldDatabase} [db] - Database for persistence
   */
  constructor(worldId, name, onEmpty, db) {
    this.id = worldId;
    this.name = name;
    this._onEmpty = onEmpty;
    this._db = db || null;

    /** @type {WorldMap} Canonical block occupancy */
    this.worldMap = new WorldMap();

    /**
     * Map of cubes for O(1) lookup by key "x,y,z".
     * Each entry: {x, y, z, r, g, b}
     * Parallels the WorldMap entries for fast iteration during serialization.
     */
    this._cubes = new Map(); // Map<string, {x, y, z, r, g, b}>

    // Load persisted blocks if this world already exists in the database
    this._loadPersistedBlocks();

    /** @type {Map<string, Player>} */
    this.players = new Map();

    /** Spawn position for new players */
    this._spawnX = 0;
    this._spawnY = 5;
    this._spawnZ = 0;

    /** Auto-destroy timer (null = not counting down) */
    this._destroyTimer = null;

    /** Tick interval reference */
    this._tickInterval = null;

    // Start the tick loop
    this._startTick();
  }

  /**
   * Load blocks from the database into memory.
   * Called once during construction. If no database is configured or the
   * world has no persisted blocks, this is a no-op.
   */
  _loadPersistedBlocks() {
    if (!this._db) return;

    const blocks = this._db.loadWorldBlocks(this.id);
    for (const block of blocks) {
      const { x, y, z, r, g, b } = block;
      const bx = Math.floor(x);
      const by = Math.floor(y);
      const bz = Math.floor(z);
      this.worldMap.place(bx, by, bz);
      this._cubes.set(`${x},${y},${z}`, { x, y, z, r, g, b });
    }
    if (blocks.length > 0) {
      console.log(`[world ${this.id}] Loaded ${blocks.length} persisted block(s) from database.`);
    }
  }

  /**
   * Bulk-load blocks into memory without broadcasting or re-persisting.
   * Used by the Cloudflare worker after generating a fresh terrain world.
   *
   * @param {Array<{x:number, y:number, z:number, r:number, g:number, b:number}>} blocks
   */
  loadBlocksFromArray(blocks) {
    for (const block of blocks) {
      const { x, y, z, r, g, b } = block;
      const bx = Math.floor(x);
      const by = Math.floor(y);
      const bz = Math.floor(z);
      this.worldMap.place(bx, by, bz);
      this._cubes.set(`${x},${y},${z}`, { x, y, z, r, g, b });
    }
  }

  /**
   * Override the spawn position (used by generated terrain worlds so the
   * player spawns on the surface instead of in mid-air).
   * @param {number} x
   * @param {number} y
   * @param {number} z
   */
  setSpawn(x, y, z) {
    this._spawnX = x;
    this._spawnY = y;
    this._spawnZ = z;
  }

  // --- Player Management ---

  /**
   * Add a player to this world.
   * Sends joined+worldState to the joiner, broadcasts playerJoined to others.
   *
   * @param {Player} player
   */
  addPlayer(player) {
    // Cancel destroy timer if running
    if (this._destroyTimer) {
      clearTimeout(this._destroyTimer);
      this._destroyTimer = null;
    }

    // Set spawn position
    player.posX = this._spawnX;
    player.posY = this._spawnY;
    player.posZ = this._spawnZ;

    // Send world state to the new player FIRST
    this._sendTo(player.ws, {
      type: JOINED,
      playerId: player.id,
      worldId: this.id,
      spawnX: this._spawnX,
      spawnY: this._spawnY,
      spawnZ: this._spawnZ,
    });

    // Send full world state (cubes + existing players)
    const otherPlayers = [];
    for (const p of this.players.values()) {
      otherPlayers.push(p.getJoinInfo());
    }

    this._sendTo(player.ws, {
      type: WORLD_STATE,
      cubes: Array.from(this._cubes.values()).map(c => [c.x, c.y, c.z, c.r, c.g, c.b]),
      players: otherPlayers,
    });

    // Broadcast to existing players
    this.broadcast({
      type: PLAYER_JOINED,
      ...player.getJoinInfo(),
    }, player.ws); // exclude the new player from broadcast

    // Add to players map
    this.players.set(player.id, player);

    console.log(`[world ${this.id}] Player "${player.nickname}" (${player.id}) joined. ${this.players.size} player(s) online.`);
  }

  /**
   * Remove a player from this world.
   * Broadcasts playerLeft to remaining players.
   * If world is now empty, starts the destroy countdown.
   *
   * @param {Player} player
   */
  removePlayer(player) {
    this.players.delete(player.id);
    console.log(`[world ${this.id}] Player "${player.nickname}" (${player.id}) left. ${this.players.size} player(s) online.`);

    // Notify remaining players
    this.broadcast({
      type: PLAYER_LEFT,
      id: player.id,
    });

    // Start destroy timer if empty
    if (this.players.size === 0) {
      console.log(`[world ${this.id}] Empty — will be destroyed in ${WORLD_DESTROY_TIMEOUT_MS / 1000}s if no one joins.`);
      this._destroyTimer = setTimeout(() => {
        console.log(`[world ${this.id}] Destroy timer expired. Removing world.`);
        this._stopTick();
        this._onEmpty(this.id);
      }, WORLD_DESTROY_TIMEOUT_MS);
    }
  }

  // --- Block Operations ---

  /**
   * Place a block at the given world center coordinates.
   * Validates: position not occupied, not overlapping any player AABB.
   *
   * @param {number} x - World X (block center, e.g. 5.5)
   * @param {number} y - World Y (block center)
   * @param {number} z - World Z (block center)
   * @param {number} r - Red 0-1
   * @param {number} g - Green 0-1
   * @param {number} b - Blue 0-1
   * @returns {{ok: boolean, reason?: string}}
   */
  placeBlock(x, y, z, r, g, b) {
    const bx = Math.floor(x);
    const by = Math.floor(y);
    const bz = Math.floor(z);

    // Check occupancy
    if (this.worldMap.isBlockOccupied(bx, by, bz)) {
      return { ok: false, reason: 'occupied' };
    }

    // Check player overlap
    const players = Array.from(this.players.values());
    if (doesBlockOverlapAnyPlayer(x, y, z, players)) {
      return { ok: false, reason: 'player_overlap' };
    }

    // Place block
    this.worldMap.place(bx, by, bz);
    this._cubes.set(`${x},${y},${z}`, { x, y, z, r, g, b });

    // Persist to database
    if (this._db) {
      try {
        this._db.saveBlock(this.id, x, y, z, r, g, b);
      } catch (err) {
        console.error(`[world ${this.id}] Failed to persist placed block at ${x},${y},${z}:`, err.message);
      }
    }

    // Broadcast to all
    this.broadcast({
      type: BLOCK_PLACED,
      x, y, z, r, g, b,
    });

    return { ok: true };
  }

  /**
   * Remove a block at the given world center coordinates.
   *
   * @param {number} x - World X (block center)
   * @param {number} y - World Y (block center)
   * @param {number} z - World Z (block center)
   * @returns {{ok: boolean, reason?: string}}
   */
  removeBlock(x, y, z) {
    const bx = Math.floor(x);
    const by = Math.floor(y);
    const bz = Math.floor(z);

    if (!this.worldMap.isBlockOccupied(bx, by, bz)) {
      return { ok: false, reason: 'not_found' };
    }

    this.worldMap.remove(bx, by, bz);

    // Remove from map (O(1) by key)
    this._cubes.delete(`${x},${y},${z}`);

    // Remove from database
    if (this._db) {
      try {
        this._db.removeBlock(this.id, x, y, z);
      } catch (err) {
        console.error(`[world ${this.id}] Failed to persist block removal at ${x},${y},${z}:`, err.message);
      }
    }

    // Broadcast to all
    this.broadcast({
      type: BLOCK_REMOVED,
      x, y, z,
    });

    return { ok: true };
  }

  // --- Player Input Processing ---

  /**
   * Process ALL of a player's accumulated inputs through authoritative physics.
   * Called during the tick loop. Processes every input in order so the server
   * simulation matches the client's multi-frame prediction.
   *
   * @param {Player} player
   * @returns {string|null} The animation name for the last processed input
   */
  processPlayerInput(player) {
    const inputs = player.consumeInput();
    if (!inputs || inputs.length === 0) return null;

    let lastAnim = null;
    let lastSeq = 0;

    // Build list of other player positions for ground-on-head detection.
    // Uses positions from the current tick (players processed so far may have
    // been updated, others are from the previous tick — close enough for
    // head-standing ground detection).
    const otherPlayers = Array.from(this.players.values())
      .filter(p => p.id !== player.id);

    for (const input of inputs) {
      const { inputKeys, rotationY, delta, seq } = input;

      // Cap delta to prevent speed hacks
      const cappedDelta = Math.min(delta, MAX_DELTA);

      // Run authoritative simulation using the CLIENT-SENT rotation (not stale stored value)
      const newState = simulateStep(
        {
          posX: player.posX,
          posY: player.posY,
          posZ: player.posZ,
          rotationY: rotationY,
          velocityY: player.velocityY,
          isGrounded: player.isGrounded,
          isJumping: player.isJumping,
        },
        inputKeys,
        this.worldMap,
        cappedDelta,
        { players: otherPlayers }
      );

      // Update player state
      player.posX = newState.posX;
      player.posY = newState.posY;
      player.posZ = newState.posZ;
      player.rotationY = rotationY;
      player.velocityY = newState.velocityY;
      player.isGrounded = newState.isGrounded;
      player.isJumping = newState.isJumping;
      player.lastProcessedSeq = seq;
      lastSeq = seq;
      lastAnim = newState.desiredAnim;
    }

    // Send reconciliation for the LAST processed seq only
    // (client replays all later inputs from this authoritative base state)
    this._sendTo(player.ws, {
      type: RECONCILE,
      seq: lastSeq,
      posX: player.posX,
      posY: player.posY,
      posZ: player.posZ,
      velocityY: player.velocityY,
      isGrounded: player.isGrounded,
      rotationY: player.rotationY,
    });

    return lastAnim;
  }

  // --- Tick Loop ---

  _startTick() {
    this._tickInterval = setInterval(() => this._tick(), TICK_INTERVAL_MS);
  }

  _stopTick() {
    if (this._tickInterval) {
      clearInterval(this._tickInterval);
      this._tickInterval = null;
    }
  }

  /**
   * Server tick: process all pending player inputs and broadcast states.
   * Always broadcasts when players are present to ensure smooth interpolation.
   * Sends per-player filtered states to avoid echoing a player's own state back.
   */
  _tick() {
    if (this.players.size === 0) return;

    const now = Date.now();

    // Process all player inputs first.
    // For idle players (e.g. background tab, no messages received), run a
    // gravity-only step so they still fall if pushed off a ledge.
    const tickDelta = TICK_INTERVAL_MS / 1000;
    const anims = new Map(); // playerId → anim name
    for (const player of this.players.values()) {
      const anim = this.processPlayerInput(player);
      if (anim !== null) {
        anims.set(player.id, anim);
      } else {
        // No inputs queued — run a gravity-only simulation step
        const otherPlayers = Array.from(this.players.values())
          .filter(p => p.id !== player.id);
        const newState = simulateStep(
          {
            posX: player.posX, posY: player.posY, posZ: player.posZ,
            rotationY: player.rotationY, velocityY: player.velocityY,
            isGrounded: player.isGrounded, isJumping: player.isJumping,
          },
          { w: false, a: false, s: false, d: false, space: false },
          this.worldMap,
          tickDelta,
          { players: otherPlayers }
        );
        player.posX = newState.posX;
        player.posY = newState.posY;
        player.posZ = newState.posZ;
        player.velocityY = newState.velocityY;
        player.isGrounded = newState.isGrounded;
        player.isJumping = newState.isJumping;
        anims.set(player.id, newState.desiredAnim);
      }
    }

    // Keep vertically-attached players glued to their carrier's head.
    // When the carrier moves down (falling/descending from a jump), the
    // rider must follow immediately.  Without this, the rider drifts above
    // the carrier's head creating a gap that exceeds the 0.06 tolerance in
    // checkPlayerOnAnyPlayer, causing a false detachment.  resolvePlayerOverlaps
    // only handles penetration (rider inside carrier), not gaps.
    //
    // Only snaps riders that are still grounded — a rider who just jumped
    // (isGrounded=false) is detaching and should not be pulled back down.
    for (const player of this.players.values()) {
      if (player.attachedTo && player.isGrounded) {
        const carrier = this.players.get(player.attachedTo);
        if (carrier) {
          const carrierHeadY = carrier.posY + CHAR_HEIGHT;
          if (player.posY > carrierHeadY) {
            player.posY = carrierHeadY;
            player.velocityY = 0;
          }
        }
      }
    }

    // Resolve player-player overlaps so characters don't walk through each other.
    // Must run AFTER all inputs are processed but BEFORE broadcasting states.
    if (this.players.size >= 2) {
      resolvePlayerOverlaps(Array.from(this.players.values()));
    }

    // Fix any block overlaps caused by player-player resolution.
    // This prevents players from being pushed through walls or into the ground
    // when another player pushes them.
    for (const player of this.players.values()) {
      const pos = { x: player.posX, y: player.posY, z: player.posZ };
      resolveAnyOverlapOnWorld(pos, this.worldMap);
      player.posX = pos.x;
      player.posY = pos.y;
      player.posZ = pos.z;
    }

    // Re-evaluate ground state after player-player pushes.
    // A player pushed off a ledge must start falling immediately — their
    // isGrounded flag is stale from before the push.
    // Conversely, a player pushed onto another player's head must be marked
    // grounded so they don't fall through on the next tick.
    //
    // Also tracks the vertical-attached state: when a player is standing on
    // another player's head, attachedTo is set so the client can apply local
    // Y prediction and eliminate interpolation lag for head-standing visuals.
    const playerList = Array.from(this.players.values());
    for (const player of this.players.values()) {
      // Reset attachedTo each tick; it will be set below if the player
      // is standing on another player's head.
      player.attachedTo = null;

      if (player.isGrounded) {
        const pos = { x: player.posX, y: player.posY, z: player.posZ };
        const onBlock = checkPlayerGrounded(pos, this.worldMap);
        const onPlayer = checkPlayerOnAnyPlayer(pos, playerList, player.id);

        if (!onBlock && !onPlayer) {
          // No longer grounded — they were pushed off a ledge or the player
          // below moved out from under them.
          player.isGrounded = false;
        } else if (onPlayer && !onBlock) {
          // Only standing on another player (not blocks) — record who
          for (const other of playerList) {
            if (other.id === player.id) continue;
            const otherHeadY = other.posY + CHAR_HEIGHT;
            if (Math.abs(pos.y - otherHeadY) < 0.06) {
              player.attachedTo = other.id;
              break;
            }
          }
        }
        // If onBlock is true (with or without onPlayer), attachedTo stays null.
        // Block-grounding takes priority for attachment tracking.
      } else {
        // Player is airborne — check if they've landed on another player
        const pos = { x: player.posX, y: player.posY, z: player.posZ };
        if (checkPlayerOnAnyPlayer(pos, playerList, player.id)) {
          // Snap feet to the top of the player below
          for (const other of playerList) {
            if (other.id === player.id) continue;
            const otherHeadY = other.posY + CHAR_HEIGHT;
            if (Math.abs(pos.y - otherHeadY) < 0.06) {
              player.posY = otherHeadY;
              player.attachedTo = other.id;
              break;
            }
          }
          player.isGrounded = true;
          player.velocityY = 0;
          player.isJumping = false;
        }
      }
    }

    // Build state snapshots from the resolved positions
    const states = [];
    for (const player of this.players.values()) {
      states.push(player.getPublicState(anims.get(player.id)));
    }

    // Send each player only the states of OTHER players (no echo),
    // including a server timestamp for accurate interpolation.
    if (states.length > 0) {
      for (const player of this.players.values()) {
        const filtered = states.filter(s => s.id !== player.id);
        if (filtered.length > 0) {
          this._sendTo(player.ws, {
            type: PLAYER_STATES,
            states: filtered,
            serverTime: now,
          });
        }
      }
    }
  }

  // --- Chat ---

  /**
   * Broadcast a chat message to all players in this world.
   * @param {Player} sender
   * @param {string} text
   */
  broadcastChat(sender, text) {
    this.broadcast({
      type: CHAT,
      fromId: sender.id,
      nickname: sender.nickname,
      text,
      timestamp: Date.now(),
    });
  }

  // --- Utility ---

  /**
   * Send a JSON message to a specific WebSocket.
   */
  _sendTo(ws, msg) {
    if (ws.readyState === 1) { // WebSocket.OPEN
      ws.send(JSON.stringify(msg));
    }
  }

  /**
   * Broadcast a JSON message to all players, optionally excluding one.
   * @param {object} msg
   * @param {import('ws').WebSocket} [excludeWs] - WebSocket to exclude from broadcast
   */
  broadcast(msg, excludeWs) {
    const data = JSON.stringify(msg);
    for (const player of this.players.values()) {
      if (player.ws !== excludeWs && player.ws.readyState === 1) {
        player.ws.send(data);
      }
    }
  }

  /**
   * Get world info for the discovery list.
   */
  getInfo() {
    return {
      id: this.id,
      name: this.name,
      playerCount: this.players.size,
      cubeCount: this._cubes.size,
    };
  }

  /**
   * Clean up all resources.
   */
  destroy() {
    this._stopTick();
    if (this._destroyTimer) {
      clearTimeout(this._destroyTimer);
      this._destroyTimer = null;
    }
    // Disconnect all players
    for (const player of this.players.values()) {
      player.ws.close();
    }
    this.players.clear();
    this.worldMap.clear();
    this._cubes.clear();
  }
}
