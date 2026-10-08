import { VoxelRaycaster } from '../world/VoxelRaycaster.js';
import { MAX_RAY_DISTANCE, GROUND_SIZE } from '../../shared/constants.js';
import { checkPlayerBlockOverlap, doesBlockOverlapAnyPlayer } from '../../shared/physics.js';

/**
 * Handles mouse/touch interaction for placing and removing cubes.
 *
 * In multiplayer mode, after a successful local block operation (optimistic),
 * the action is sent to the server via NetworkClient. The server echoes it back
 * to all clients — the sender ignores its own echoed operations via
 * `_lastLocalBlockOp` tracking.
 */
export class InteractionManager {
  /**
   * @param {HTMLElement} domElement
   * @param {THREE.Camera} camera
   * @param {import('./CubeManager.js').CubeManager} cubeManager
   * @param {import('../../shared/WorldMap.js').WorldMap} worldMap
   * @param {import('../ui/ControllerGUI.js').ControllerGUI} controllerGUI
   * @param {import('./LegoCharacter.js').LegoCharacter} legoCharacter
   * @param {import('../ui/ColorPicker.js').ColorPicker} [colorPicker]
   * @param {import('../net/NetworkClient.js').NetworkClient} [networkClient] - For multiplayer block sync
   */
  constructor(domElement, camera, cubeManager, worldMap, controllerGUI, legoCharacter, colorPicker, networkClient) {
    this._dom = domElement;
    this._camera = camera;
    this._cubeMgr = cubeManager;
    this._worldMap = worldMap;
    this._ctrlGUI = controllerGUI;
    this._lego = legoCharacter;
    this._colorPicker = colorPicker;
    this._networkClient = networkClient || null;

    /**
     * Remote player positions for overlap checks.
     * Prevents client-side optimistic placement in cells occupied by remote players,
     * which avoids the "block flash" when the server rejects it.
     * @type {Array<{id:string, posX:number, posY:number, posZ:number}>}
     */
    this._remotePlayerPositions = [];

    this._pointerMoved = false;
    this._downPos = { x: 0, y: 0 };
    this._deadzone = 3; // px — prevent orbit micro-movements from canceling clicks

    /**
     * Last local block operation for server-echo idempotency.
     * When the server echoes back our own blockPlaced/blockRemoved,
     * we compare with this and skip if it matches.
     * @type {{x:number, y:number, z:number, type:string, timestamp:number}|null}
     */
    this.lastLocalBlockOp = null;

    this._onPointerDown = (e) => {
      if (e.button === 0 || e.button === 2) {
        this._pointerMoved = false;
        this._downPos.x = e.clientX;
        this._downPos.y = e.clientY;
      }
    };

    this._onPointerMove = (e) => {
      const dx = e.clientX - this._downPos.x;
      const dy = e.clientY - this._downPos.y;
      if (dx * dx + dy * dy > this._deadzone * this._deadzone) {
        this._pointerMoved = true;
      }
    };

    this._onPointerUp = (e) => {
      if (e.button !== 0 && e.button !== 2) return;
      if (this._pointerMoved) return;

      // In Follow mode there is no visible crosshair — disable cube placement/removal
      if (this._ctrlGUI.currentName === 'Follow') return;

      // In pointer-lock modes (FPS, Follow), skip if pointer isn't locked yet
      if (this._isPointerLock() && document.pointerLockElement !== this._dom) return;

      const pointerLock = this._isPointerLock();

      const { origin, direction } = pointerLock
        ? VoxelRaycaster.centerRay(this._camera)
        : VoxelRaycaster.screenToRay(e.clientX, e.clientY, this._camera, this._dom);

      const hit = VoxelRaycaster.raycast(origin, direction, this._worldMap, MAX_RAY_DISTANCE);

      // Right-click or Ctrl+Left-click: remove block
      if (e.button === 2 || (e.button === 0 && e.ctrlKey)) {
        if (hit) {
          this._removeCube(hit.cubeX, hit.cubeY, hit.cubeZ);
        }
        return;
      }

      // Left button — place cube
      if (hit) {
        if (this._canPlaceBlock(hit.placeX, hit.placeY, hit.placeZ)) {
          this._placeCube(hit.placeX, hit.placeY, hit.placeZ);
        }
        return;
      }

      // No cube hit — try ground
      const cell = VoxelRaycaster.pickGround(origin, direction, GROUND_SIZE, MAX_RAY_DISTANCE);
      if (cell && this._canPlaceBlock(cell.x, 0.5, cell.z)) {
        this._placeCube(cell.x, 0.5, cell.z);
      }
    };

    this._onContextMenu = (e) => e.preventDefault();

    domElement.addEventListener('pointerdown', this._onPointerDown);
    domElement.addEventListener('pointermove', this._onPointerMove);
    domElement.addEventListener('pointerup', this._onPointerUp);
    domElement.addEventListener('contextmenu', this._onContextMenu);
  }

  /**
   * Place a cube at (x, y, z). Applies optimistically, then sends to server.
   */
  _placeCube(x, y, z) {
    // Determine color
    let r, g, b;
    if (this._colorPicker) {
      const color = this._colorPicker.getSelectedColor();
      if (color) {
        r = color.r; g = color.g; b = color.b;
      } else {
        r = Math.random(); g = Math.random(); b = Math.random();
      }
    } else {
      r = Math.random(); g = Math.random(); b = Math.random();
    }

    const placed = this._cubeMgr.addCubeWithColor(x, y, z, r, g, b);
    if (placed && this._networkClient && this._networkClient.connected) {
      // Track for idempotency
      this.lastLocalBlockOp = { x, y, z, type: 'place', timestamp: performance.now() };
      // Send to server
      this._networkClient.send({ type: 'placeBlock', x, y, z, r, g, b });
    }
  }

  /**
   * Remove a cube at (x, y, z). Applies optimistically, then sends to server.
   */
  _removeCube(x, y, z) {
    const removed = this._cubeMgr.removeCubeAt(x, y, z);
    if (removed && this._networkClient && this._networkClient.connected) {
      this.lastLocalBlockOp = { x, y, z, type: 'remove', timestamp: performance.now() };
      this._networkClient.send({ type: 'removeBlock', x, y, z });
    }
  }

  /**
   * Place a cube at the camera's centre target (crosshair).
   * Used by the keyboard action key (Z) — same logic as a left click.
   */
  placeAtTarget() {
    if (this._ctrlGUI && this._ctrlGUI.currentName === 'Follow') return;

    const { origin, direction } = VoxelRaycaster.centerRay(this._camera);
    const hit = VoxelRaycaster.raycast(origin, direction, this._worldMap, MAX_RAY_DISTANCE);

    if (hit) {
      if (this._canPlaceBlock(hit.placeX, hit.placeY, hit.placeZ)) {
        this._placeCube(hit.placeX, hit.placeY, hit.placeZ);
      }
      return;
    }

    // No cube hit — try ground
    const cell = VoxelRaycaster.pickGround(origin, direction, GROUND_SIZE, MAX_RAY_DISTANCE);
    if (cell && this._canPlaceBlock(cell.x, 0.5, cell.z)) {
      this._placeCube(cell.x, 0.5, cell.z);
    }
  }

  /**
   * Remove a cube at the camera's centre target (crosshair).
   * Used by the keyboard action key (C) — same logic as a right click.
   */
  removeAtTarget() {
    if (this._ctrlGUI && this._ctrlGUI.currentName === 'Follow') return;

    const { origin, direction } = VoxelRaycaster.centerRay(this._camera);
    const hit = VoxelRaycaster.raycast(origin, direction, this._worldMap, MAX_RAY_DISTANCE);
    if (hit) {
      this._removeCube(hit.cubeX, hit.cubeY, hit.cubeZ);
    }
  }

  _isPointerLock() {
    return this._ctrlGUI.currentName === 'FPS' || this._ctrlGUI.currentName === 'Follow';
  }

  /**
   * Set remote player positions for overlap checking.
   * Called each frame from main.js to keep the data fresh for pointer events.
   * @param {Array<{id:string, posX:number, posY:number, posZ:number}>} positions
   */
  setRemotePlayerPositions(positions) {
    this._remotePlayerPositions = positions || [];
  }

  /**
   * Check whether a block can be placed at (worldX, worldY, worldZ).
   * Returns false if the block would overlap ANY player (local or remote),
   * so the placement is rejected instead of pushing players around.
   */
  _canPlaceBlock(worldX, worldY, worldZ) {
    const bx = Math.floor(worldX);
    const by = Math.floor(worldY);
    const bz = Math.floor(worldZ);

    // Check local player
    const pos = this._lego.group.position;
    if (checkPlayerBlockOverlap({ x: pos.x, y: pos.y, z: pos.z }, bx, by, bz)) {
      return false;
    }

    // Check remote players — prevents "block flash" from server rejection
    if (this._remotePlayerPositions.length > 0 &&
        doesBlockOverlapAnyPlayer(worldX, worldY, worldZ, this._remotePlayerPositions)) {
      return false;
    }

    return true;
  }

  dispose() {
    this._dom.removeEventListener('pointerdown', this._onPointerDown);
    this._dom.removeEventListener('pointermove', this._onPointerMove);
    this._dom.removeEventListener('pointerup', this._onPointerUp);
    this._dom.removeEventListener('contextmenu', this._onContextMenu);
  }
}
