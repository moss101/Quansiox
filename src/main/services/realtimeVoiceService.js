'use strict';
/**
 * The realtime voice transport.
 *
 * The reference implementation's voice call is a server-side model: the
 * client opens a WebSocket to a realtime endpoint with a minted credential,
 * streams PCM frames, and receives audio and transcripts back. The protocol
 * is the OpenAI-Realtime shape, and it is the shape every compatible server
 * speaks.
 *
 * This module is that client, made provider-agnostic: the endpoint and the
 * credential come from the settings, so it can point at a local realtime
 * server, a self-hosted one, or a hosted one — the local-first product
 * never hard-codes a vendor.
 *
 * It is also honest about what it cannot do: it does not terminate TLS, it
 * does not do the echo cancellation, and it does not fake a server. If the
 * endpoint is unreachable, the call says so.
 */
const { EventEmitter } = require('node:events');

/** The lifecycle of a realtime session. */
const PHASE = {
  IDLE: 'idle',
  CONNECTING: 'connecting',
  LIVE: 'live',
  RECONNECTING: 'reconnecting',
  ENDING: 'ending',
  CLOSED: 'closed',
};

/** The default timeout for the handshake. */
const CONNECT_TIMEOUT_MS = 15_000;

/**
 * A realtime voice session.
 *
 * Events:
 *   `phase`    — the phase changed
 *   `audio`    — a base64 audio delta from the model
 *   `text`     — a transcript delta
 *   `message`  — a server event that is not audio or text
 *   `error`    — the session failed
 */
class RealtimeVoiceSession extends EventEmitter {
  /**
   * @param {object} opts
   * @param {string} opts.url            the realtime endpoint
   * @param {string} opts.credential     the client secret / token
   * @param {string} [opts.model]
   * @param {string} [opts.protocol]     the subprotocol
   * @param {object} [opts.session]      the session.update payload
   * @param {boolean} [opts.resume]      ask for resumption
   */
  constructor(opts = {}) {
    super();
    this.url = String(opts.url ?? '');
    this.credential = String(opts.credential ?? '');
    this.model = opts.model ?? '';
    this.protocol = opts.protocol ?? null;
    this.sessionUpdate = opts.session ?? {};
    this.resume = opts.resume !== false;
    this.phase = PHASE.IDLE;
    this.socket = null;
    this.closed = false;
    this.turns = 0;
    this.lastEventAtMs = 0;
    this._connectTimeout = null;
  }

  /** Move to a phase and announce it. */
  _setPhase(phase) {
    if (this.phase === phase) return;
    this.phase = phase;
    this.emit('phase', phase);
  }

  /** Open the socket and perform the handshake. */
  async connect() {
    if (!this.url) throw new Error('the realtime endpoint is not configured');
    if (!this.credential) throw new Error('no realtime credential was minted');
    this._setPhase(PHASE.CONNECTING);

    const WebSocketImpl = optsWs();
    if (!WebSocketImpl) throw new Error('no WebSocket implementation is available');

    const socket = new WebSocketImpl(this.url, this.protocol ? [this.protocol] : undefined);
    this.socket = socket;
    socket.binaryType = 'arraybuffer';

    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        try { socket.close(); } catch { /* already closed */ }
        reject(new Error('the realtime handshake timed out'));
      }, CONNECT_TIMEOUT_MS);
      const cleanup = () => {
        clearTimeout(timer);
        socket.removeEventListener?.('open', onOpen);
        socket.removeEventListener?.('error', onError);
      };
      const onOpen = () => { cleanup(); resolve(); };
      const onError = (error) => { cleanup(); reject(error instanceof Error ? error : new Error('the realtime connection failed')); };
      socket.addEventListener?.('open', onOpen, { once: true });
      socket.addEventListener?.('error', onError, { once: true });
    });

    socket.addEventListener?.('message', (event) => this._onMessage(event));
    socket.addEventListener?.('close', () => {
      if (!this.closed) this._setPhase(PHASE.CLOSED);
    });
    socket.addEventListener?.('error', (error) => {
      this.emit('error', error instanceof Error ? error : new Error('the realtime connection failed'));
    });

    // The session handshake: what the model should listen for and say.
    this.send('session.update', {
      ...this.sessionUpdate,
      ...(this.resume ? { resumption: { enabled: true } } : {}),
    });
    this._setPhase(PHASE.LIVE);
    this.lastEventAtMs = Date.now();
    return this;
  }

  /** Handle an incoming server event. */
  _onMessage(event) {
    this.lastEventAtMs = Date.now();
    let data = event?.data;
    if (typeof data !== 'string') {
      // A binary frame: the model's audio.
      this.emit('audio', data);
      return;
    }
    let parsed;
    try { parsed = JSON.parse(data); } catch { return; }
    const type = parsed?.type ?? '';
    if (type === 'response.audio.delta' || type === 'response.output_audio.delta') {
      this.emit('audio', parsed.delta);
      return;
    }
    if (type.includes('transcription') && type.endsWith('.delta')) {
      this.emit('text', parsed.delta ?? '');
      return;
    }
    if (type === 'input_audio_buffer.committed' || type === 'response.done') {
      this.turns += 1;
    }
    this.emit('message', parsed);
  }

  /** Send a client event. */
  send(type, payload = {}) {
    if (!this.socket) throw new Error('the realtime session is not connected');
    this.socket.send(JSON.stringify({ type, ...payload }));
  }

  /** Stream an audio chunk (base64 PCM). */
  sendAudio(base64) {
    this.send('input_audio_buffer.append', { audio: base64 });
  }

  /** Commit the buffered audio, ending the user's turn. */
  commitAudio() {
    this.send('input_audio_buffer.commit', {});
  }

  /** Ask the model to start speaking. */
  nudge() {
    this.send('response.create', {});
  }

  /** How long since the last thing the server said. */
  idleMs() {
    return this.lastEventAtMs ? Date.now() - this.lastEventAtMs : 0;
  }

  /** Close the session. */
  close() {
    this.closed = true;
    this._setPhase(PHASE.CLOSED);
    try { this.socket?.close(); } catch { /* already closed */ }
    this.socket = null;
  }
}

/** The WebSocket implementation, if there is one. */
function optsWs() {
  try {
    // `ws` is a dependency; the browser's WebSocket is not usable from the
    // main process under Electron's older versions.
    return require('ws');
  } catch {
    return typeof WebSocket !== 'undefined' ? WebSocket : null;
  }
}

/**
 * The realtime configuration for this install.
 *
 * @returns {{ configured: boolean, url: string, model: string, reason: string|null }}
 */
function realtimeConfig() {
  let settings = {};
  try {
    settings = require('./settingsService').settingsService.load() ?? {};
  } catch { /* settings unavailable */ }
  const url = String(settings.realtimeUrl ?? '').trim();
  const model = String(settings.realtimeModel ?? '').trim();
  if (!url) {
    return {
      configured: false,
      url: '',
      model,
      reason: 'no realtime endpoint is configured (set one in Settings → Voice)',
    };
  }
  return { configured: true, url, model, reason: null };
}

module.exports = {
  CONNECT_TIMEOUT_MS,
  PHASE,
  RealtimeVoiceSession,
  realtimeConfig,
};
