import { CHARACTER_PRESETS } from '../../shared/constants.js';

/**
 * World style → display label & colour dot used in the world list.
 */
const STYLE_META = {
  green:    { label: 'Green',    color: '#3a8f4f' },
  forest:   { label: 'Forest',   color: '#2e7d32' },
  desert:   { label: 'Desert',   color: '#d9b45f' },
  snow:     { label: 'Snow',     color: '#dce8f2' },
  ocean:    { label: 'Ocean',    color: '#2f7bb8' },
  volcano:  { label: 'Volcano',  color: '#e05a1a' },
  candy:    { label: 'Candy',    color: '#c86bd6' },
  cave:     { label: 'Cave',     color: '#6d5a6e' },
  skyisland:{ label: 'Sky Isle', color: '#4f9d69' },
  random:   { label: 'Random',   color: '#8899cc' },
};

function styleMeta(id) {
  return STYLE_META[id] || { label: '—', color: '#556688' };
}

/**
 * Manages DOM overlays: main menu, HUD, disconnect message.
 *
 * Controls visibility transitions between menu and game canvas.
 * Pointer lock is managed externally (by FPSController/FollowController).
 */
export class UIManager {
  constructor() {
    this._menuOverlay = null;
    this._hud = null;
    this._worldListTable = null;
    this._nicknameInput = null;
    this._playerCountEl = null;
    this._worldNameEl = null;
    this._onJoinCallback = null;
    this._onRefreshCallback = null;
    this._onOfflineCallback = null;
    this._onDeleteWorldCallback = null;
    this._onCharacterSelectCallback = null;
    this._selectedCharacterId = localStorage.getItem('voxellab_character') || 'classic';
    this._facePreviewCanvas = null;

    this._createMenuOverlay();
    this._createHUD();
    this._createHelpOverlay();
  }

  // ============================================================
  // Main Menu
  // ============================================================

  _createMenuOverlay() {
    // Create overlay
    const overlay = document.createElement('div');
    overlay.id = 'menu-overlay';
    overlay.innerHTML = `
      <div class="menu-container">
        <h1 class="menu-title">VOXEL LAB</h1>
        <p class="menu-subtitle">Multiplayer Creative Building</p>

        <div class="menu-section">
          <label class="menu-label" for="nickname-input">Nickname</label>
          <input type="text" id="nickname-input" class="menu-input" maxlength="20"
                 placeholder="Enter your nickname..." autocomplete="off" />
        </div>

        <div class="menu-section">
          <label class="menu-label">Choose Your Character</label>
          <div id="character-grid" class="character-grid"></div>
        </div>

        <div class="menu-section">
          <button id="btn-create-world" class="menu-btn menu-btn-primary">Create New World</button>
        </div>

        <div class="menu-section">
          <div class="menu-divider"><span>Discover Worlds</span></div>
          <div id="world-list-container" class="world-list-container">
            <p class="menu-hint">Click Refresh to load available worlds</p>
          </div>
          <button id="btn-refresh-worlds" class="menu-btn menu-btn-secondary">Refresh List</button>
        </div>

        <div class="menu-section">
          <div class="menu-divider"><span>or</span></div>
          <button id="btn-offline" class="menu-btn menu-btn-secondary">Play Offline</button>
        </div>

        <div class="menu-section">
          <button id="btn-help" class="menu-btn menu-btn-secondary">How to Play &amp; Setup</button>
        </div>

        <p class="menu-hint" style="margin-top: 1rem; font-size: 0.75rem;">
          Hosted on Cloudflare — click "How to Play &amp; Setup" for details.
        </p>
      </div>

      <div id="create-modal">
        <div class="create-modal-box">
          <h2>Create New World</h2>
          <label class="menu-label" for="create-world-name">World Name</label>
          <input type="text" id="create-world-name" class="menu-input" maxlength="50"
                 placeholder="e.g. myworld" autocomplete="off" />

          <label class="menu-label" for="create-world-style">World Style</label>
          <select id="create-world-style" class="menu-input">
            <option value="">Random Style</option>
            <option value="green">Green Mountains</option>
            <option value="forest">Forest</option>
            <option value="desert">Desert</option>
            <option value="snow">Snow / Ice</option>
            <option value="ocean">Ocean</option>
            <option value="volcano">Volcano</option>
            <option value="candy">Candy Rainbow</option>
            <option value="cave">Cave</option>
            <option value="skyisland">Sky Islands</option>
          </select>

          <label class="menu-label" for="create-world-seed">Seed (optional)</label>
          <input type="text" id="create-world-seed" class="menu-input" maxlength="20"
                 placeholder="Blank = random" autocomplete="off" />
          <p class="menu-hint" style="font-size:0.75rem;">Same name + seed + style always makes the same world.</p>

          <div class="menu-section">
            <button id="btn-create-confirm" class="menu-btn menu-btn-primary">Create</button>
            <button id="btn-create-cancel" class="menu-btn menu-btn-secondary" style="margin-top:0.5rem;">Cancel</button>
          </div>
        </div>
      </div>

      <div id="face-preview">
        <canvas width="170" height="200"></canvas>
        <div class="face-preview-name">—</div>
      </div>
    `;
    document.body.appendChild(overlay);
    this._menuOverlay = overlay;

    // Cache elements
    this._nicknameInput = overlay.querySelector('#nickname-input');
    this._worldListTable = overlay.querySelector('#world-list-container');
    this._facePreviewCanvas = overlay.querySelector('#face-preview canvas');
    this._facePreviewName = overlay.querySelector('.face-preview-name');

    // Restore nickname from localStorage
    const savedNick = localStorage.getItem('voxellab_nickname');
    if (savedNick) {
      this._nicknameInput.value = savedNick;
    }

    // Cache create-modal elements
    this._createModal = overlay.querySelector('#create-modal');
    this._createWorldName = overlay.querySelector('#create-world-name');
    this._createWorldStyle = overlay.querySelector('#create-world-style');
    this._createWorldSeed = overlay.querySelector('#create-world-seed');

    // Button handlers
    overlay.querySelector('#btn-create-world').addEventListener('click', () => {
      this._showCreateModal();
    });

    overlay.querySelector('#btn-create-confirm').addEventListener('click', () => {
      this._submitCreateModal();
    });

    overlay.querySelector('#btn-create-cancel').addEventListener('click', () => {
      this._hideCreateModal();
    });

    overlay.querySelector('#btn-refresh-worlds').addEventListener('click', () => {
      if (this._onRefreshCallback) {
        this._onRefreshCallback();
      }
    });

    // Offline mode button
    overlay.querySelector('#btn-offline').addEventListener('click', () => {
      if (this._onOfflineCallback) {
        this._onOfflineCallback();
      }
    });

    // Help button
    overlay.querySelector('#btn-help').addEventListener('click', () => {
      this.showHelp();
    });

    // Build character selection cards
    this._createCharacterCards();

    // Draw initial face preview
    const initialPreset = CHARACTER_PRESETS.find(p => p.id === this._selectedCharacterId) || CHARACTER_PRESETS[0];
    this._updateFacePreview(initialPreset);
  }

  /**
   * Build the 4 preset character selection cards inside #character-grid.
   */
  _createCharacterCards() {
    const grid = this._menuOverlay.querySelector('#character-grid');
    if (!grid) return;

    grid.innerHTML = '';

    for (const preset of CHARACTER_PRESETS) {
      const card = document.createElement('button');
      card.className = 'character-card';
      card.dataset.presetId = preset.id;

      // Mark as selected if this is the current choice
      if (preset.id === this._selectedCharacterId) {
        card.classList.add('selected');
      }

      const rgb = (c) => `rgb(${Math.round(c.r * 255)},${Math.round(c.g * 255)},${Math.round(c.b * 255)})`;

      card.innerHTML = `
        <div class="character-card-name">${preset.name}</div>
        <div class="character-card-swatches">
          <span class="color-swatch" style="background:${rgb(preset.shirt)}"></span>
          <span class="color-swatch" style="background:${rgb(preset.pants)}"></span>
          <span class="color-swatch" style="background:${rgb(preset.shoes)}"></span>
          <span class="color-swatch" style="background:${rgb(preset.skin)}"></span>
          <span class="color-swatch" style="background:${rgb(preset.hair)}"></span>
        </div>
      `;

      card.addEventListener('click', () => {
        this._selectedCharacterId = preset.id;
        localStorage.setItem('voxellab_character', preset.id);

        // Update card highlights
        const cards = grid.querySelectorAll('.character-card');
        for (const c of cards) {
          c.classList.toggle('selected', c.dataset.presetId === preset.id);
        }

        // Update face preview
        this._updateFacePreview(preset);

        // Fire callback for live 3D preview
        if (this._onCharacterSelectCallback) {
          this._onCharacterSelectCallback(preset.id);
        }
      });

      grid.appendChild(card);
    }
  }

  /**
   * Draw a polaroid-style face portrait on the preview canvas.
   * @param {object} preset - The character preset {id, name, shirt, pants, shoes, skin, hair}
   */
  _updateFacePreview(preset) {
    if (!this._facePreviewCanvas) return;

    const canvas = this._facePreviewCanvas;
    const ctx = canvas.getContext('2d');
    const W = canvas.width;   // 170
    const H = canvas.height;  // 200
    const cx = W / 2;         // center x = 85

    ctx.clearRect(0, 0, W, H);

    const css = (c) => `rgb(${Math.round(c.r * 255)},${Math.round(c.g * 255)},${Math.round(c.b * 255)})`;
    const skin = css(preset.skin);
    const hair = css(preset.hair);
    const shirt = css(preset.shirt);

    // --- Background glow ---
    const bg = ctx.createRadialGradient(cx, 100, 20, cx, 100, 110);
    bg.addColorStop(0, 'rgba(100, 140, 255, 0.08)');
    bg.addColorStop(1, 'rgba(100, 140, 255, 0)');
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, W, H);

    // --- Hair (bulky lego-style top) ---
    // Bushy top
    ctx.fillStyle = hair;
    ctx.beginPath();
    ctx.ellipse(cx, 38, 48, 20, 0, Math.PI, Math.PI * 2);
    ctx.fill();

    // Left side hair
    ctx.fillRect(cx - 48, 28, 14, 40);

    // Right side hair
    ctx.fillRect(cx + 34, 28, 14, 40);

    // Top tuft
    ctx.beginPath();
    ctx.ellipse(cx, 24, 30, 14, 0, Math.PI, Math.PI * 2);
    ctx.fill();

    // --- Face oval ---
    ctx.fillStyle = skin;
    ctx.beginPath();
    ctx.ellipse(cx, 72, 36, 44, 0, 0, Math.PI * 2);
    ctx.fill();

    // --- Eyes (lego stud style — small dots) ---
    ctx.fillStyle = '#000';
    ctx.beginPath();
    ctx.arc(cx - 14, 64, 4, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.arc(cx + 14, 64, 4, 0, Math.PI * 2);
    ctx.fill();

    // Eye highlight (makes them look alive)
    ctx.fillStyle = '#fff';
    ctx.beginPath();
    ctx.arc(cx - 16, 62, 1.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.arc(cx + 12, 62, 1.5, 0, Math.PI * 2);
    ctx.fill();

    // --- Cheek blush ---
    ctx.fillStyle = 'rgba(255, 140, 140, 0.25)';
    ctx.beginPath();
    ctx.ellipse(cx - 24, 80, 7, 5, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.ellipse(cx + 24, 80, 7, 5, 0, 0, Math.PI * 2);
    ctx.fill();

    // --- Smile ---
    ctx.strokeStyle = '#000';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(cx, 76, 12, 0.15 * Math.PI, 0.85 * Math.PI);
    ctx.stroke();

    // --- Shirt collar ---
    ctx.fillStyle = shirt;
    ctx.beginPath();
    ctx.moveTo(cx - 30, 110);
    ctx.lineTo(cx + 30, 110);
    ctx.lineTo(cx + 38, 140);
    ctx.lineTo(cx - 38, 140);
    ctx.closePath();
    ctx.fill();

    // Collar detail
    ctx.fillStyle = 'rgba(0, 0, 0, 0.15)';
    ctx.beginPath();
    ctx.moveTo(cx, 110);
    ctx.lineTo(cx - 8, 130);
    ctx.lineTo(cx + 8, 130);
    ctx.closePath();
    ctx.fill();

    // --- Label ---
    if (this._facePreviewName) {
      this._facePreviewName.textContent = preset.name;
    }
  }

  /**
   * Get the current nickname from the input field.
   * Saves to localStorage if valid.
   * @returns {string|null}
   */
  _getNickname() {
    const name = (this._nicknameInput.value || '').trim();
    if (!name) {
      alert('Please enter a nickname.');
      return null;
    }
    if (name.length > 20) {
      alert('Nickname must be 20 characters or fewer.');
      return null;
    }
    localStorage.setItem('voxellab_nickname', name);
    return name;
  }

  // --- Create-World modal ---

  _showCreateModal() {
    if (!this._createModal) return;
    this._createModal.style.display = 'flex';
    if (this._createWorldName) this._createWorldName.focus();
  }

  _hideCreateModal() {
    if (this._createModal) {
      this._createModal.style.display = 'none';
    }
  }

  _submitCreateModal() {
    const nickname = this._getNickname();
    if (!nickname) return;

    const name = (this._createWorldName.value || '').trim().slice(0, 50);
    if (!name) {
      alert('Please enter a world name.');
      return;
    }

    const options = {};
    const style = this._createWorldStyle.value;
    if (style) options.style = style;
    const seed = this._createWorldSeed.value.trim();
    if (seed) options.seed = seed;

    this._hideCreateModal();
    if (this._onJoinCallback) {
      this._onJoinCallback(name, nickname, options);
    }
  }

  /**
   * Show the main menu overlay.
   */
  showMainMenu() {
    if (this._menuOverlay) {
      this._menuOverlay.style.display = 'flex';
    }
  }

  /**
   * Hide the main menu overlay.
   */
  hideMainMenu() {
    if (this._menuOverlay) {
      this._menuOverlay.style.display = 'none';
    }
  }

  /**
   * Update the world list display.
   * @param {Array<{id:string, name:string, playerCount:number, cubeCount:number}>} worlds
   */
  showWorldList(worlds) {
    if (!this._worldListTable) return;

    if (worlds.length === 0) {
      this._worldListTable.innerHTML = '<p class="menu-hint">No worlds available. Create one!</p>';
      return;
    }

    let html = '<table class="world-table"><thead><tr><th>World</th><th>Style</th><th>Players</th><th>Cubes</th><th></th><th></th></tr></thead><tbody>';
    for (const w of worlds) {
      const meta = styleMeta(w.style);
      html += `<tr>
        <td>${this._escapeHtml(w.name)}</td>
        <td><span class="style-dot" style="background:${meta.color}"></span>${meta.label}</td>
        <td>${w.playerCount}/10</td>
        <td>${w.cubeCount}</td>
        <td><button class="menu-btn menu-btn-join" data-world-id="${this._escapeHtml(w.id)}">Join</button></td>
        <td><button class="menu-btn menu-btn-del menu-btn-danger" data-delete-world-id="${this._escapeHtml(w.id)}">Delete</button></td>
      </tr>`;
    }
    html += '</tbody></table>';
    this._worldListTable.innerHTML = html;

    // Wire up Join buttons
    const joinButtons = this._worldListTable.querySelectorAll('button[data-world-id]');
    for (const btn of joinButtons) {
      btn.addEventListener('click', () => {
        const nickname = this._getNickname();
        if (!nickname) return;
        const worldId = btn.getAttribute('data-world-id');
        if (this._onJoinCallback && worldId) {
          this._onJoinCallback(worldId, nickname);
        }
      });
    }

    // Wire up Delete buttons
    const deleteButtons = this._worldListTable.querySelectorAll('button[data-delete-world-id]');
    for (const btn of deleteButtons) {
      btn.addEventListener('click', () => {
        const worldId = btn.getAttribute('data-delete-world-id');
        const worldName = worldId; // display name is same as ID for now
        if (!worldId) return;
        if (confirm(`Delete world "${worldName}" and all its blocks? This cannot be undone.`)) {
          if (this._onDeleteWorldCallback) {
            this._onDeleteWorldCallback(worldId);
          }
        }
      });
    }
  }

  // ============================================================
  // HUD
  // ============================================================

  _createHUD() {
    const hud = document.createElement('div');
    hud.id = 'hud';
    hud.innerHTML = `
      <div class="hud-top-left">
        <span id="hud-world-name" class="hud-world-name">—</span>
        <span id="hud-player-count" class="hud-player-count">0 players</span>
      </div>
      <div id="chat-area" class="chat-area"></div>
      <input type="text" id="chat-input" class="chat-input" placeholder="Press Enter to chat..."
             maxlength="200" autocomplete="off" />
      <button id="btn-help-hud" class="help-hud-btn" title="Help / Setup">? Help</button>
    `;
    document.body.appendChild(hud);
    this._hud = hud;
    this._worldNameEl = hud.querySelector('#hud-world-name');
    this._playerCountEl = hud.querySelector('#hud-player-count');
    this._chatArea = hud.querySelector('#chat-area');
    this._chatInput = hud.querySelector('#chat-input');

    hud.querySelector('#btn-help-hud').addEventListener('click', () => {
      this.showHelp();
    });
  }

  /**
   * Show the HUD overlay.
   */
  showHUD() {
    if (this._hud) {
      this._hud.style.display = 'block';
    }
  }

  /**
   * Hide the HUD overlay.
   */
  hideHUD() {
    if (this._hud) {
      this._hud.style.display = 'none';
    }
  }

  /**
   * Update HUD info.
   * @param {string} worldName
   * @param {number} playerCount
   */
  updateHUD(worldName, playerCount) {
    if (this._worldNameEl) {
      this._worldNameEl.textContent = worldName || '—';
    }
    if (this._playerCountEl) {
      this._playerCountEl.textContent = `${playerCount} player${playerCount !== 1 ? 's' : ''}`;
    }
  }

  // ============================================================
  // Chat
  // ============================================================

  /**
   * Show the chat input (for typing).
   */
  showChatInput() {
    if (this._chatInput) {
      this._chatInput.style.display = 'block';
      this._chatInput.focus();
    }
  }

  /**
   * Hide the chat input.
   * @returns {string} The current input text (empty if hidden without sending)
   */
  hideChatInput() {
    if (this._chatInput) {
      const text = this._chatInput.value;
      this._chatInput.value = '';
      this._chatInput.style.display = 'none';
      this._chatInput.blur();
      return text;
    }
    return '';
  }

  /**
   * Get chat input value without clearing.
   * @returns {string}
   */
  getChatInput() {
    return this._chatInput ? this._chatInput.value : '';
  }

  /**
   * Check if chat input is currently focused.
   * @returns {boolean}
   */
  isChatFocused() {
    return this._chatInput && document.activeElement === this._chatInput;
  }

  /**
   * Add a chat message to the display area.
   * @param {string} nickname
   * @param {string} text
   */
  addChatMessage(nickname, text) {
    if (!this._chatArea) return;

    const msgEl = document.createElement('div');
    msgEl.className = 'chat-message';
    msgEl.innerHTML = `<span class="chat-nickname">${this._escapeHtml(nickname)}:</span> ${this._escapeHtml(text)}`;
    this._chatArea.appendChild(msgEl);

    // Auto-scroll
    this._chatArea.scrollTop = this._chatArea.scrollHeight;

    // Fade and remove after timeout
    setTimeout(() => {
      msgEl.style.opacity = '0';
      msgEl.style.transition = 'opacity 2s';
      setTimeout(() => {
        if (msgEl.parentNode) {
          msgEl.parentNode.removeChild(msgEl);
        }
      }, 2000);
    }, 8000);

    // Limit visible messages
    while (this._chatArea.children.length > 10) {
      this._chatArea.removeChild(this._chatArea.firstChild);
    }
  }

  // ============================================================
  // Callbacks
  // ============================================================

  /**
   * Set the callback for when the user wants to join a world.
   * @param {function(string, string):void} callback - (worldId, nickname)
   */
  onJoin(callback) {
    this._onJoinCallback = callback;
  }

  /**
   * Set the callback for when the user clicks "Refresh List".
   * When called without arguments, triggers the currently set callback.
   * @param {function():void} [callback]
   */
  onRefreshWorlds(callback) {
    if (callback) {
      this._onRefreshCallback = callback;
    } else if (this._onRefreshCallback) {
      this._onRefreshCallback();
    }
  }

  /**
   * Set the callback for when the user clicks "Play Offline".
   * @param {function():void} callback
   */
  onOffline(callback) {
    this._onOfflineCallback = callback;
  }

  /**
   * Set the callback for when the user clicks "Delete" on a world.
   * @param {function(string):void} callback - (worldId)
   */
  onDeleteWorld(callback) {
    this._onDeleteWorldCallback = callback;
  }

  /**
   * Set the callback for when the user selects a character preset.
   * @param {function(string):void} callback - Receives the preset ID
   */
  onCharacterSelect(callback) {
    this._onCharacterSelectCallback = callback;
  }

  /**
   * Get the currently selected character preset ID.
   * @returns {string}
   */
  getSelectedCharacterId() {
    return this._selectedCharacterId;
  }

  // ============================================================
  // Help overlay
  // ============================================================

  _createHelpOverlay() {
    const overlay = document.createElement('div');
    overlay.id = 'help-overlay';
    overlay.innerHTML = `
      <div class="help-container">
        <h1>VoxelLab 使用與設定說明</h1>
        <p class="help-subtle">這是一款多人方塊建造沙盒遊戲（Three.js + Cloudflare Workers）。</p>

        <h2>一、如何開始玩</h2>
        <ol>
          <li>輸入<strong>暱稱</strong>（最多 20 字元），並選擇一個角色。</li>
          <li>點「<strong>Create New World</strong>」→ 輸入世界名稱、選<strong>世界風格</strong>（或留空隨機）、可填<strong>種子 Seed</strong>（留空隨機）→ 建立後會<strong>自動隨機生成地形</strong>。</li>
          <li>或從下方清單點「<strong>Join</strong>」加入別人已存在的世界。</li>
          <li>想單人練習就點「<strong>Play Offline</strong>」。</li>
          <li>進入遊戲後<strong>點一下畫面</strong>鎖定滑鼠即可操作；按 <code>Esc</code> 釋放滑鼠。</li>
        </ol>

        <h3>世界風格</h3>
        <ul>
          <li><strong>Green Mountains</strong> 綠地山脈（預設）</li>
          <li><strong>Forest</strong> 茂密森林</li>
          <li><strong>Desert</strong> 沙漠</li>
          <li><strong>Snow / Ice</strong> 雪地冰原</li>
          <li><strong>Ocean</strong> 海洋</li>
          <li><strong>Volcano</strong> 火山熔岩</li>
          <li><strong>Candy Rainbow</strong> 彩虹糖果</li>
          <li><strong>Cave</strong> 地下洞穴（地形內含隧道）</li>
          <li><strong>Sky Islands</strong> 漂浮空島</li>
          <li>風格 + 種子相同 → 一定生成一模一樣的世界。世界清單會顯示每個世界的風格。</li>
        </ul>

        <h2>二、操作控制</h2>
        <table class="help-table">
          <tr><th>動作</th><th>按鍵 / 滑鼠</th></tr>
          <tr><td>移動</td><td><code>W A S D</code> 或 <code>↑ ↓ ← →</code> 方向鍵</td></tr>
          <tr><td>跳躍</td><td><code>Space</code> 或 <code>X</code></td></tr>
          <tr><td>放置方塊</td><td>滑鼠<strong>左鍵</strong>，或 <code>Z</code>（準心處）</td></tr>
          <tr><td>移除方塊</td><td>滑鼠<strong>右鍵</strong>，或 <code>C</code>（準心處）</td></tr>
          <tr><td>視角模式</td><td>按 <code>H</code> 開啟設定面板切換（Orbit / Follow / FPS）</td></tr>
          <tr><td>選擇方塊顏色</td><td>按 <code>H</code> → 開啟 <code>Color Picker</code> 選色</td></tr>
          <tr><td>聊天（多人）</td><td><code>Enter</code> 或 <code>V</code> 開啟輸入，再 <code>Enter</code> 送出</td></tr>
          <tr><td>離開／關閉聊天</td><td><code>Esc</code></td></tr>
        </table>
        <p class="help-subtle">Orbit 模式：左鍵拖曳旋轉、右鍵拖曳縮放；FPS 模式才有第一人稱滑鼠視角。</p>

        <h2>三、多人玩法</h2>
        <ul>
          <li>每位朋友開啟<strong>同一個網址</strong>，輸入<strong>相同世界名稱</strong>即可一起建造。</li>
          <li>世界是<strong>持久的</strong>：關閉網頁後，方塊仍會保留。</li>
          <li>「<strong>Delete</strong>」可刪除整個世界（不可復原，請小心）。</li>
          <li>最多 10 人同時在一個世界。</li>
        </ul>

        <h2>四、離線單人模式</h2>
        <ul>
          <li>在網址後加 <code>?offline</code>，例如 <code>.../workers.dev/?offline</code>。</li>
          <li>離線模式會把自己的場景存到雲端（同一個世界名稱），下次會自動載入。</li>
        </ul>

        <h2>五、設定與維護（站長專區）</h2>
        <h3>正式網址</h3>
        <p><code>https://voxellab.weiz30.workers.dev</code></p>

        <h3>本機開發</h3>
        <ul>
          <li>前端開發：<code>npm run dev</code> → 開啟 <code>http://localhost:5173</code></li>
          <li>舊版本機遊戲伺服器：<code>npm run server</code>（僅在需要測 Node 版時用）</li>
        </ul>

        <h3>改完程式重新部署</h3>
        <pre><code>npm run build
npx wrangler deploy</code></pre>
        <p class="help-subtle">建置前記得先改 <code>client/</code> 或 <code>worker/</code> 的程式。</p>

        <h3>其他常用指令</h3>
        <ul>
          <li>看即時日誌：<code>npx wrangler tail</code></li>
          <li>本機模擬測試：<code>npx wrangler dev</code></li>
          <li>看目前登入帳號：<code>npx wrangler whoami</code></li>
        </ul>

        <h3>免費額度提醒</h3>
        <ul>
          <li>Durable Object：每天 <strong>100,000 次請求</strong>、<strong>13,000 GB-s</strong>、<strong>5 GB 儲存</strong>。</li>
          <li>有人連線遊玩時才會累計執行時間；小規模使用都在免費範圍內。</li>
          <li>原始碼位於本機 <code>D:\\OpenCode\\VoxelLab</code>。</li>
        </ul>

        <button id="btn-help-close" class="menu-btn menu-btn-primary help-btn-close">Close / 關閉</button>
      </div>
    `;
    document.body.appendChild(overlay);
    this._helpOverlay = overlay;

    overlay.querySelector('#btn-help-close').addEventListener('click', () => {
      this.hideHelp();
    });

    // Clicking the backdrop (outside the panel) also closes it.
    overlay.addEventListener('click', (event) => {
      if (event.target === overlay) this.hideHelp();
    });
  }

  showHelp() {
    if (this._helpOverlay) {
      this._helpOverlay.style.display = 'flex';
    }
  }

  hideHelp() {
    if (this._helpOverlay) {
      this._helpOverlay.style.display = 'none';
    }
  }

  // ============================================================
  // Disconnect overlay
  // ============================================================

  /**
   * Show a temporary disconnect message.
   */
  showDisconnected() {
    const el = document.createElement('div');
    el.className = 'disconnect-overlay';
    el.textContent = 'Disconnected. Returning to menu...';
    document.body.appendChild(el);
    setTimeout(() => {
      if (el.parentNode) el.parentNode.removeChild(el);
    }, 3000);
  }

  // ============================================================
  // Utility
  // ============================================================

  _escapeHtml(text) {
    return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
}
