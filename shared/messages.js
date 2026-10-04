/**
 * Message type constants and serialization helpers for the multiplayer protocol.
 *
 * All messages are JSON objects with a mandatory "type" field.
 * This module is pure JavaScript — no dependencies on Three.js or Node.js APIs.
 */

// --- Message type constants ---

/** Client→Server: Request the list of active worlds */
export const DISCOVER = 'discover';

/** Server→Client: Response with world list */
export const WORLD_LIST = 'worldList';

/** Client→Server: Join or create a world */
export const JOIN = 'join';

/** Server→Client: Confirmation that the player has joined */
export const JOINED = 'joined';

/** Server→Client: Full world state (cubes + players) for the new joiner */
export const WORLD_STATE = 'worldState';

/** Server→All: A new player has joined the world */
export const PLAYER_JOINED = 'playerJoined';

/** Server→All: A player has left the world */
export const PLAYER_LEFT = 'playerLeft';

/** Client→Server: The player's current input state (for CSP) */
export const PLAYER_STATE = 'playerState';

/** Server→All: Batched remote player states for interpolation */
export const PLAYER_STATES = 'playerStates';

/** Server→Sender: Authoritative state reconciliation */
export const RECONCILE = 'reconcile';

/** Client→Server: Request to place a block */
export const PLACE_BLOCK = 'placeBlock';

/** Client→Server: Request to remove a block */
export const REMOVE_BLOCK = 'removeBlock';

/** Server→All: A block was placed (confirmation) */
export const BLOCK_PLACED = 'blockPlaced';

/** Server→All: A block was removed (confirmation) */
export const BLOCK_REMOVED = 'blockRemoved';

/** Server→Sender: Block operation was rejected */
export const BLOCK_REJECTED = 'blockRejected';

/** Client→Server: Send a chat message */
export const CHAT = 'chat';

/** Client→Server: Leave the current world */
export const LEAVE = 'leave';

// --- Message factory functions ---

/**
 * Create a discover message.
 * @returns {{type: string}}
 */
export function createDiscoverMessage() {
  return { type: DISCOVER };
}

/**
 * Create a join message.
 * @param {string} worldId
 * @param {string} nickname
 * @param {string} [characterId='classic']
 * @param {{style?: string, seed?: string|number}} [options] - terrain style / seed for brand-new worlds
 * @returns {{type: string, worldId: string, nickname: string, characterId: string, style?: string, seed?: string|number}}
 */
export function createJoinMessage(worldId, nickname, characterId = 'classic', options = {}) {
  const msg = { type: JOIN, worldId, nickname, characterId };
  if (options.style) msg.style = options.style;
  if (options.seed !== undefined && options.seed !== null && options.seed !== '') {
    msg.seed = String(options.seed);
  }
  return msg;
}

/**
 * Create a player state message (sent from client to server each frame).
 * @param {number} seq - Monotonically increasing sequence number
 * @param {{w:boolean, a:boolean, s:boolean, d:boolean, space:boolean}} inputKeys
 * @param {number} rotationY - Character yaw rotation in radians
 * @param {number} delta - Frame delta time
 * @returns {{type: string, seq: number, inputKeys: object, rotationY: number, delta: number}}
 */
export function createPlayerStateMessage(seq, inputKeys, rotationY, delta) {
  return { type: PLAYER_STATE, seq, inputKeys, rotationY, delta };
}

/**
 * Create a place block message.
 * @param {number} x - World X (block center)
 * @param {number} y - World Y (block center)
 * @param {number} z - World Z (block center)
 * @param {number} r - Red (0-1)
 * @param {number} g - Green (0-1)
 * @param {number} b - Blue (0-1)
 * @returns {{type: string, x: number, y: number, z: number, r: number, g: number, b: number}}
 */
export function createPlaceBlockMessage(x, y, z, r, g, b) {
  return { type: PLACE_BLOCK, x, y, z, r, g, b };
}

/**
 * Create a remove block message.
 * @param {number} x - World X (block center)
 * @param {number} y - World Y (block center)
 * @param {number} z - World Z (block center)
 * @returns {{type: string, x: number, y: number, z: number}}
 */
export function createRemoveBlockMessage(x, y, z) {
  return { type: REMOVE_BLOCK, x, y, z };
}

/**
 * Create a chat message.
 * @param {string} text
 * @returns {{type: string, text: string}}
 */
export function createChatMessage(text) {
  return { type: CHAT, text };
}

/**
 * Create a leave message.
 * @returns {{type: string}}
 */
export function createLeaveMessage() {
  return { type: LEAVE };
}
