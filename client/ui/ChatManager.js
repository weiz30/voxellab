/**
 * Manages chat input focus and message sending.
 *
 * Works with UIManager for DOM elements and InputManager for key detection.
 * Flow:
 *   1. Press Enter when not in chat → show input, release pointer lock
 *   2. Type message, press Enter → send, hide input, re-acquire pointer lock
 *   3. Press Escape → cancel, hide input, re-acquire pointer lock
 */
export class ChatManager {
  /**
   * @param {import('./UIManager.js').UIManager} uiManager
   * @param {import('./InputManager.js').InputManager} inputManager
   * @param {HTMLCanvasElement} canvas - The renderer's canvas element (for pointer lock)
   */
  constructor(uiManager, inputManager, canvas) {
    this._ui = uiManager;
    this._input = inputManager;
    this._canvas = canvas;
    this._onSendCallback = null;

    /** Chat input is currently visible/active */
    this._chatActive = false;

    // Handle Enter on the chat input directly
    if (this._ui._chatInput) {
      this._ui._chatInput.addEventListener('keydown', (e) => {
        if (e.code === 'Enter') {
          e.preventDefault();
          this._sendMessage();
        } else if (e.code === 'Escape') {
          e.preventDefault();
          this._cancelChat();
        }
      });
    }
  }

  /**
   * Update chat state based on key presses. Call every frame.
   */
  update() {
    // Check for Enter/V press (toggle chat)
    if (this._input.consumeKey('chat') || this._input.consumeKey('enter')) {
      if (!this._chatActive && !this._ui.isChatFocused()) {
        this._openChat();
      }
    }

    // Check for Escape press (cancel chat)
    if (this._input.consumeKey('escape')) {
      if (this._chatActive || this._ui.isChatFocused()) {
        this._cancelChat();
      }
    }
  }

  /**
   * Open the chat input for typing.
   */
  _openChat() {
    this._chatActive = true;

    // Temporarily exit pointer lock so the user can type
    if (document.pointerLockElement === this._canvas) {
      document.exitPointerLock();
    }

    this._ui.showChatInput();
  }

  /**
   * Send the current chat message.
   */
  _sendMessage() {
    const text = this._ui.hideChatInput().trim();
    this._chatActive = false;

    if (text && this._onSendCallback) {
      this._onSendCallback(text);
    }

    // Re-acquire pointer lock in FPS/Follow modes
    this._requestPointerLock();
  }

  /**
   * Cancel chat without sending.
   */
  _cancelChat() {
    this._ui.hideChatInput();
    this._chatActive = false;

    // Re-acquire pointer lock
    this._requestPointerLock();
  }

  /**
   * Request pointer lock on the canvas.
   */
  _requestPointerLock() {
    // Only re-lock in FPS/Follow modes — the ControllerGUI manages this
    // We just request it; if already in a pointer-lock mode, the controller
    // will re-lock on next click anyway
    if (document.pointerLockElement !== this._canvas) {
      this._canvas.requestPointerLock();
    }
  }

  /**
   * Set the callback for when the user sends a message.
   * @param {function(string):void} callback
   */
  onSend(callback) {
    this._onSendCallback = callback;
  }

  /**
   * Add a received message to the chat display.
   * @param {string} nickname
   * @param {string} text
   */
  addMessage(nickname, text) {
    this._ui.addChatMessage(nickname, text);
  }
}
