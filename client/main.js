import * as THREE from 'three';
import Stats from 'stats.js';
import { LegoCharacter } from './player/LegoCharacter.js';
import { ControllerGUI } from './ui/ControllerGUI.js';
import { ChunkManager } from './world/ChunkManager.js';
import { WorldMap } from '../shared/WorldMap.js';
import { CubeManager } from './player/CubeManager.js';
import { InputManager } from './player/InputManager.js';
import { CharacterController } from './player/CharacterController.js';
import { InteractionManager } from './player/InteractionManager.js';
import { SceneArchive } from './world/SceneArchive.js';
import { ColorPicker } from './ui/ColorPicker.js';
import { NetworkClient } from './net/NetworkClient.js';
import { StateManager } from './net/StateManager.js';
import { RemotePlayerManager } from './net/RemotePlayerManager.js';
import { UIManager } from './ui/UIManager.js';
import { ChatManager } from './ui/ChatManager.js';
import { createJoinMessage, createPlayerStateMessage } from '../shared/messages.js';
import { getPresetById } from '../shared/constants.js';
import { checkPlayerOnAnyPlayer } from '../shared/physics.js';

// ============================================================
// Scene, Camera, Renderer
// ============================================================
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x111122);

const camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, 1000);
camera.position.set(5, 3, 8);
camera.lookAt(0, 0, 0);

const renderer = new THREE.WebGLRenderer();
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
document.body.appendChild(renderer.domElement);

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

// ============================================================
// Lego Character (initialized with saved or default preset)
// ============================================================
const savedCharId = localStorage.getItem('voxellab_character') || 'classic';
const defaultPreset = getPresetById(savedCharId);
const lego = new LegoCharacter(defaultPreset);
lego.group.position.set(0, 0, 0);
scene.add(lego.group);
lego.play('idle');

// ============================================================
// Camera Controller
// ============================================================
const controllerGUI = new ControllerGUI(camera, renderer.domElement, lego, scene);

// ============================================================
// Grid & Lighting
// ============================================================
const GROUND_SIZE = 50;
const gridHelper = new THREE.GridHelper(GROUND_SIZE, GROUND_SIZE, 0x88aaff, 0x335588);
scene.add(gridHelper);

const ambientLight = new THREE.AmbientLight(0xffffff, 0.5);
scene.add(ambientLight);

const directionalLight = new THREE.DirectionalLight(0xffffff, 1.5);
directionalLight.position.set(5, 10, 7);
scene.add(directionalLight);

const fillLight = new THREE.DirectionalLight(0x88aaff, 0.5);
fillLight.position.set(-5, 0, 5);
scene.add(fillLight);

const spotLight = new THREE.SpotLight(0xffffff, 2);
spotLight.angle = 0.6;
spotLight.penumbra = 0.3;
spotLight.decay = 1;
spotLight.distance = 30;
spotLight.target.position.set(0, 0, -1);
camera.add(spotLight);
scene.add(camera);

// ============================================================
// Cube System
// ============================================================
const chunkManager = new ChunkManager();
chunkManager.attachToScene(scene);

const worldMap = new WorldMap();
const cubeManager = new CubeManager(chunkManager, worldMap);

// ============================================================
// Input
// ============================================================
const inputManager = new InputManager();

// ============================================================
// Character Physics & Animation
// ============================================================
const characterController = new CharacterController(lego, worldMap, inputManager, controllerGUI);

// ============================================================
// Color Picker
// ============================================================
const colorPicker = new ColorPicker(renderer.domElement);

// ============================================================
// UI Manager
// ============================================================
const uiManager = new UIManager();

/**
 * Currently selected character preset ID.
 * Updated when user clicks a character card on the menu.
 * @type {string}
 */
let selectedCharacterId = uiManager.getSelectedCharacterId();

// Live preview: update the 3D character when user picks a preset
uiManager.onCharacterSelect((presetId) => {
  const preset = getPresetById(presetId);
  lego.setColors(preset);
  selectedCharacterId = presetId;
});

// ============================================================
// Chat Manager
// ============================================================
const chatManager = new ChatManager(uiManager, inputManager, renderer.domElement);

// ============================================================
// Network Layer (created on demand)
// ============================================================
let networkClient = null;
let stateManager = null;
let remotePlayerManager = null;
let interactionManager = null;
let isMultiplayer = false;

// ============================================================
// GUI setup
// ============================================================
controllerGUI.setupCameraController(lego, scene);
controllerGUI.setupSceneManager(cubeManager, characterController, lego, GROUND_SIZE);
controllerGUI.setupAssetManager({ colorPicker });

// Hide Scene Manager by default — only shown when user selects offline mode.
// In online mode the server manages the world; at the menu no mode is active yet.
// The Game Settings panel itself is hidden until the user enters a world.
controllerGUI.showSceneManager(false);

// ============================================================
// Stats
// ============================================================
const stats = new Stats();
stats.showPanel(0);
document.body.appendChild(stats.dom);

// ============================================================
// Menu → Game Flow
// ============================================================

/**
 * Start multiplayer mode: connect to server and join a world.
 * @param {string} worldId
 * @param {string} nickname
 */
function joinMultiplayerWorld(worldId, nickname, options = {}) {
  isMultiplayer = true;

  // Switch Asset Manager to online mode (Tool Box visible, Color Picker hidden)
  controllerGUI.setOnlineMode();

  // Hide Scene Manager — the server manages the world in online mode
  controllerGUI.showSceneManager(false);

  // Create network layer
  networkClient = new NetworkClient();
  stateManager = new StateManager();
  stateManager.nickname = nickname;
  remotePlayerManager = new RemotePlayerManager(scene, stateManager);

  // Set up message handler
  networkClient.onMessage((msg) => handleNetworkMessage(msg));

  networkClient.onClose(() => {
    console.log('[main] Connection closed');
    if (isMultiplayer) {
      uiManager.showDisconnected();
      setTimeout(() => returnToMenu(), 2000);
    }
  });

  networkClient.onOpen(() => {
    networkClient.send(createJoinMessage(worldId, nickname, selectedCharacterId, options));
    console.log(`[main] Joining world "${worldId}" as "${nickname}" with char "${selectedCharacterId}"...`);
  });

  // Connect — same-origin WebSocket endpoint (/ws), protocol follows the page.
  // The worldId is carried in the URL so the Worker can route to the right
  // Durable Object before the join handshake.
  const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const serverUrl = `${wsProtocol}//${window.location.host}/ws?worldId=${encodeURIComponent(worldId)}`;
  networkClient.connect(serverUrl);
}

/**
 * Start offline (single-player) mode.
 */
async function startOfflineMode() {
  isMultiplayer = false;

  // Show Scene Manager — scenes are managed locally in offline mode
  controllerGUI.showSceneManager(true);

  // Load last scene
  let lastScene = SceneArchive.getLastScene();
  let loadedSceneName = null;

  if (lastScene) {
    const loaded = await SceneArchive.load(lastScene, cubeManager, characterController, lego);
    if (loaded) loadedSceneName = lastScene;
  }

  if (!loadedSceneName) {
    const myworldLoaded = await SceneArchive.load('myworld', cubeManager, characterController, lego);
    if (myworldLoaded) loadedSceneName = 'myworld';
  }

  if (!loadedSceneName) {
    lego.group.position.set(0, 0, 0);
    lego.group.rotation.y = 0;
    const scenes = await SceneArchive.list();
    if (scenes.length === 0) {
      const name = window.prompt('No scenes found. Enter a name for your first scene:');
      if (name && name.trim() && /^[\w-]+$/.test(name.trim())) {
        const trimmed = name.trim();
        const ok = await SceneArchive.createDefault(trimmed, cubeManager, characterController, lego, GROUND_SIZE);
        if (ok) loadedSceneName = trimmed;
      }
    }
  }

  if (loadedSceneName) {
    await controllerGUI.syncCurrentScene(loadedSceneName);
  } else {
    await controllerGUI.syncCurrentScene('');
  }

  if (controllerGUI.currentName === 'Orbit') {
    controllerGUI.controllers['Orbit'].rebaseOnCharacter(lego);
  }

  // Create interaction manager
  interactionManager = new InteractionManager(
    renderer.domElement, camera, cubeManager,
    worldMap, controllerGUI, lego, colorPicker
  );

  // Switch Asset Manager to offline mode (Color Picker visible, Tool Box hidden)
  controllerGUI.setOfflineMode();

  // Enter game
  enterGame('Offline', 1);
}

/**
 * Enter the game (hide menu, show HUD, start loop if not already running).
 */
function enterGame(worldName, playerCount) {
  uiManager.hideMainMenu();
  uiManager.showHUD();
  uiManager.updateHUD(worldName, playerCount);
  controllerGUI.enterGame();
}

/**
 * Return to the main menu from the game.
 */
function returnToMenu() {
  isMultiplayer = false;

  // Hide the Game Settings panel and disable hotkeys
  controllerGUI.leaveGame();

  // Hide Scene Manager — back at menu, no mode selected yet
  controllerGUI.showSceneManager(false);

  // Disconnect network
  if (networkClient) {
    networkClient.close();
    networkClient = null;
  }
  stateManager = null;

  // Remove remote players
  if (remotePlayerManager) {
    remotePlayerManager.clearAll();
    remotePlayerManager = null;
  }

  // Clear world
  cubeManager.clearAll();

  // Reset character
  lego.group.position.set(0, 0, 0);
  lego.group.rotation.y = 0;
  characterController.applyState({
    posX: 0, posY: 0, posZ: 0, rotationY: 0,
    velocityY: 0, isGrounded: true,
  });

  uiManager.hideHUD();
  uiManager.showMainMenu();
}

// ============================================================
// UI Callbacks
// ============================================================

uiManager.onJoin((worldId, nickname, options) => {
  joinMultiplayerWorld(worldId, nickname, options);
});

uiManager.onRefreshWorlds(() => {
  refreshWorldList();
});

const refreshWorldList = () => {
  fetch('/api/worlds')
    .then(r => r.json())
    .then(data => {
      uiManager.showWorldList(data.worlds || []);
    })
    .catch(() => {
      uiManager.showWorldList([]);
      console.warn('[main] Could not reach server. Is "npm run server" running?');
    });
};

// Initial refresh on load
refreshWorldList();

uiManager.onOffline(() => {
  startOfflineMode();
});

uiManager.onDeleteWorld((worldId) => {
  fetch(`/api/worlds/${encodeURIComponent(worldId)}`, { method: 'DELETE' })
    .then(r => r.json())
    .then(() => {
      console.log(`[main] World "${worldId}" deleted.`);
      refreshWorldList();
    })
    .catch((err) => {
      console.error(`[main] Failed to delete world "${worldId}":`, err);
    });
});

// Also allow skipping menu with URL param
const isOfflineMode = new URLSearchParams(window.location.search).has('offline');

// ============================================================
// Network Message Handler
// ============================================================

function handleNetworkMessage(msg) {
  switch (msg.type) {
    case 'joined':
      stateManager.setIdentity(msg.playerId, msg.worldId, stateManager.nickname);
      console.log(`[main] Joined world "${msg.worldId}" as ${msg.playerId}`);
      break;

    case 'worldState':
      handleWorldState(msg);
      break;

    case 'playerJoined':
      handlePlayerJoined(msg);
      break;

    case 'playerLeft':
      handlePlayerLeft(msg);
      break;

    case 'reconcile':
      handleReconcile(msg);
      break;

    case 'playerStates':
      handlePlayerStates(msg);
      break;

    case 'blockPlaced':
      handleBlockPlaced(msg);
      break;

    case 'blockRemoved':
      handleBlockRemoved(msg);
      break;

    case 'blockRejected':
      handleBlockRejected(msg);
      break;

    case 'chat':
      handleChat(msg);
      break;

    case 'error':
      console.warn('[main] Server error:', msg.message);
      break;

    default:
      console.log('[main] Unhandled message:', msg.type);
  }
}

function handleWorldState(msg) {
  console.log(`[main] World state: ${msg.cubes.length} cubes, ${msg.players.length} players`);

  // Clear and bulk-load cubes
  cubeManager.clearAll();
  cubeManager.beginBulkLoad();
  for (const cube of msg.cubes) {
    const [x, y, z, r, g, b] = cube;
    cubeManager.addCubeWithColor(x, y, z, r, g, b);
  }
  cubeManager.endBulkLoad();

  // Set local player spawn
  lego.group.position.set(0, 5, 0);

  // Create remote player models
  for (const p of msg.players) {
    if (p.id === stateManager.localPlayerId) continue;
    stateManager.addPlayer(p.id, p.nickname, p.characterId);
    remotePlayerManager.addPlayer(p.id, p.nickname, p.characterId);
  }

  // Create interaction manager if not yet created
  if (!interactionManager) {
    interactionManager = new InteractionManager(
      renderer.domElement, camera, cubeManager,
      worldMap, controllerGUI, lego, colorPicker,
      networkClient
    );
  }

  // Enter the game
  enterGame(stateManager.worldId || 'World', remotePlayerManager.count + 1);

  console.log(`[main] World ready. ${remotePlayerManager.count} other player(s) online.`);
}

function handlePlayerJoined(msg) {
  console.log(`[main] Player joined: "${msg.nickname}" (${msg.id})`);
  stateManager.addPlayer(msg.id, msg.nickname, msg.characterId);
  remotePlayerManager.addPlayer(msg.id, msg.nickname, msg.characterId);
  if (isMultiplayer) {
    uiManager.updateHUD(stateManager.worldId || '', remotePlayerManager.count + 1);
  }
}

function handlePlayerLeft(msg) {
  console.log(`[main] Player left: ${msg.id}`);
  stateManager.removePlayer(msg.id);
  remotePlayerManager.removePlayer(msg.id);
  if (isMultiplayer) {
    uiManager.updateHUD(stateManager.worldId || '', remotePlayerManager.count + 1);
  }
}

function handleReconcile(msg) {
  if (!stateManager) return;
  const { serverState, remainingInputs } = stateManager.processReconcile(msg);
  const predictedState = stateManager.repredict(serverState, remainingInputs, worldMap);

  // Safety hard-snap for extreme divergence (> 5 units = teleport / massive desync)
  const pos = lego.group.position;
  const errorDist = Math.sqrt(
    (predictedState.posX - pos.x) ** 2 +
    (predictedState.posY - pos.y) ** 2 +
    (predictedState.posZ - pos.z) ** 2
  );

  if (errorDist > 5) {
    // Extreme case — snap directly
    characterController.applyState(predictedState);
  } else {
    // Normal case — always apply smooth offset-based correction
    characterController.reconcile(predictedState);
  }
}

function handlePlayerStates(msg) {
  if (!stateManager) return;
  stateManager.processPlayerStates(msg.states, msg.serverTime);
}

function handleBlockPlaced(msg) {
  if (interactionManager && interactionManager.lastLocalBlockOp &&
      interactionManager.lastLocalBlockOp.type === 'place' &&
      Math.abs(interactionManager.lastLocalBlockOp.x - msg.x) < 0.01 &&
      Math.abs(interactionManager.lastLocalBlockOp.y - msg.y) < 0.01 &&
      Math.abs(interactionManager.lastLocalBlockOp.z - msg.z) < 0.01) {
    interactionManager.lastLocalBlockOp = null;
    return;
  }
  cubeManager.addCubeFromServer(msg.x, msg.y, msg.z, msg.r, msg.g, msg.b);
}

function handleBlockRemoved(msg) {
  if (interactionManager && interactionManager.lastLocalBlockOp &&
      interactionManager.lastLocalBlockOp.type === 'remove' &&
      Math.abs(interactionManager.lastLocalBlockOp.x - msg.x) < 0.01 &&
      Math.abs(interactionManager.lastLocalBlockOp.y - msg.y) < 0.01 &&
      Math.abs(interactionManager.lastLocalBlockOp.z - msg.z) < 0.01) {
    interactionManager.lastLocalBlockOp = null;
    return;
  }
  cubeManager.removeCubeFromServer(msg.x, msg.y, msg.z);
}

function handleBlockRejected(msg) {
  console.warn(`[main] Block rejected at (${msg.x}, ${msg.y}, ${msg.z}): ${msg.reason}`);
  if (msg.reason === 'occupied' || msg.reason === 'player_overlap') {
    cubeManager.removeCubeFromServer(msg.x, msg.y, msg.z);
  }
}

function handleChat(msg) {
  chatManager.addMessage(msg.nickname, msg.text);
}

// ============================================================
// Chat send callback
// ============================================================
chatManager.onSend((text) => {
  if (networkClient && networkClient.connected) {
    networkClient.send({ type: 'chat', text });
    // Show own message locally
    chatManager.addMessage(stateManager.nickname || 'You', text);
  }
});

// ============================================================
// Startup: Show menu or go straight to offline mode
// ============================================================

if (isOfflineMode) {
  // Skip menu, go straight to offline play
  startOfflineMode();
} else {
  // Show main menu
  uiManager.showMainMenu();

  // Auto-refresh world list on menu load
  uiManager.onRefreshWorlds();
}

// ============================================================
// Game Loop
// ============================================================
let prevTime = performance.now();
// Initialize lastFrameTime so the first rAF callback always renders.
// Using 1000/60 as a negative offset: time - (-16.67) = 16.67 >= 16.67 → passes.
const FPS_60_INTERVAL = 1000 / 60; // ~16.67 ms
let lastFrameTime = -FPS_60_INTERVAL;

function animate(time) {
  requestAnimationFrame(animate);

  // --- FPS limit: skip this frame if we're already at or above the target ---
  const fpsLimit = controllerGUI.fpsLimit;
  if (fpsLimit === '60Hz') {
    if (time - lastFrameTime < FPS_60_INTERVAL) return;
    // Advance by exactly one frame interval per render, instead of snapping
    // to real time.  This maintains correct 60 Hz pacing across any display
    // refresh rate (60/120/144 Hz) — the old "lastFrameTime = time" approach
    // caused ~48 FPS on 144 Hz displays because rAF timings don't align
    // cleanly with 16.67 ms boundaries.
    lastFrameTime += FPS_60_INTERVAL;
    // After a long pause (tab backgrounded), don't let lastFrameTime
    // fall more than 3 frames behind, or we'd render a catch-up burst.
    if (time - lastFrameTime >= FPS_60_INTERVAL) {
      lastFrameTime = time - FPS_60_INTERVAL;
    }
  }

  const now = performance.now();
  const delta = Math.min((now - prevTime) / 1000, 0.1);
  prevTime = now;

  stats.begin();

  // --- Chat manager update (checks for Enter/Escape) ---
  chatManager.update();

  // --- Local player physics + animation ---
  // Only run physics when in game (multiplayer connected or offline mode active).
  // Pass remote player positions for ground detection so the player correctly
  // shows idle (not jump/walk) when standing on another player's head.
  if (isMultiplayer || interactionManager) {
    const remotePositions = remotePlayerManager ? remotePlayerManager.getAllPositions() : [];
    characterController.update(delta, remotePositions);
    if (interactionManager) {
      interactionManager.setRemotePlayerPositions(remotePositions);
    }
  }

  // --- Player-player collision (client-side prediction) ---
  // Only head-standing detection is done client-side for instant ground feel.
  // Horizontal push is removed — the server resolves player-player overlaps
  // authoritatively and reconciles the position, which is smoother than
  // having client and server fight each other over the correction.
  if (remotePlayerManager && remotePlayerManager.count > 0) {
    const remotePositions = remotePlayerManager.getAllPositions();

    // Check if the player is standing on a remote player's head.
    // Uses proximity (not just active overlap) so we detect it even
    // when the player is perfectly positioned at the head boundary
    // with zero penetration — preventing the 2-frame gravity/snap cycle.
    if (checkPlayerOnAnyPlayer(lego.group.position, remotePositions)) {
      characterController.setGrounded(true);
      characterController.clearYCorrection();
    }
  }

  // --- CSP: send player state to server ---
  if (isMultiplayer && networkClient && networkClient.connected && stateManager) {
    // In Orbit mode, zero out the input so the server doesn't move the character.
    // The client already ignores WASD locally via the { inOrbit } flag in simulateStep,
    // but the server has no concept of camera mode — so we send empty input instead.
    const inOrbit = controllerGUI.currentName === 'Orbit';
    const rawInput = inputManager.getInputState();
    const inputState = inOrbit
      ? { w: false, a: false, s: false, d: false, space: false }
      : rawInput;
    const seq = stateManager.nextSeq();
    const rotY = lego.group.rotation.y;
    networkClient.send(createPlayerStateMessage(seq, inputState, rotY, delta));
    stateManager.pushPendingInput(seq, inputState, rotY, delta);
  }

  // --- Remote player interpolation ---
  // Pass the local player's Y and ID so RemotePlayerManager can apply
  // Y-override for remote players vertically attached to the local player
  // (bypasses 150ms interpolation delay for head-standing visuals).
  if (remotePlayerManager) {
    remotePlayerManager.update(
      delta,
      lego.group.position.y,
      stateManager ? stateManager.localPlayerId : null,
    );
  }

  // --- Camera controller ---
  controllerGUI.update(delta, lego);

  // --- Spread chunk rebuilds across frames ---
  chunkManager.rebuildDirty(worldMap);

  // --- Render ---
  renderer.render(scene, camera);

  stats.end();
}

// Start the manual rAF loop (replaces renderer.setAnimationLoop so we can
// throttle frames independently of the browser's vsync / refresh rate).
requestAnimationFrame(animate);
