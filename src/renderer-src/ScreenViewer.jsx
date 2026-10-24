import { useCallback, useEffect, useRef, useState } from 'react';
import RFB from '@novnc/novnc';

/* noVNC viewer for the live guest desktop, instrumented for real work:
 *  - clipboard both ways (guest cut-text → local clipboard, local → guest)
 *  - chord buttons (Ctrl+Alt+Del, Alt+Tab, Super) and Cmd→Super translation
 *  - IME/text mode for CJK input (composition events → keysyms)
 *  - input-correlated liveness watchdog (framebuffer updates) with a stalled
 *    banner + reconnect
 *  - an adaptive link-quality controller (bandwidth EMA → noVNC quality
 *    level), a liveness beacon and an input-correlation signal
 *  - fit / 1:1 scaling and fullscreen
 * The WebSocket is the screenBridge RFB relay to the guest's x11vnc. */
import { sendText, sendChord, metaChord, SUPER_L } from './viewer-input.js';
import { LivenessTracker } from './liveness.js';
import { QualityController } from './vnc-quality.js';

/**
 * Liveness is judged the way Grok Bot's `preload-vnc.cjs` does it
 * (`__sandVncLivenessBeacon`): a still frame is NOT a stall. A guest that
 * shows a static screen (an editor with no changes, a paused build, a
 * screensaver) legitimately sends no updates.
 *
 * The screen is only considered dead when we *proved* it is stuck:
 *   - the RFB connection is gone, or
 *   - we sent input (keys / pointer moves) and the guest still painted
 *     nothing, or
 *   - a full (non-incremental) framebuffer request got no answer.
 *
 * The previous implementation flagged "stalled" whenever 6s passed without a
 * frame, so simply *watching* an idle desktop tore the connection down and
 * reconnected in a loop.
 *
 * The decision itself lives in ./liveness.js (pure, unit tested).
 */

export default function ScreenViewer({ url, onDisconnect, viewOnly = false }) {
  const containerRef = useRef(null);
  const rfbRef = useRef(null);
  const imeRef = useRef(null);
  const liveRef = useRef(null);
  if (liveRef.current === null) liveRef.current = new LivenessTracker();
  const connectedRef = useRef(false);
  const onDisconnectRef = useRef(onDisconnect);
  const [state, setState] = useState('idle'); // idle | connecting | connected | stalled | error
  const [scale, setScale] = useState('fit');
  const [ime, setIme] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [fps, setFps] = useState(0);
  const [reconnectKey, setReconnectKey] = useState(0);
  const [banner, setBanner] = useState('');
  const [link, setLink] = useState({ quality: 6, bandwidthMbps: 0, lastSeenAgeMs: null, stuck: false, connected: false });
  // The link-quality controller (bandwidth EMA → noVNC quality level) and
  // its liveness beacon. It is pure, so the decision is unit tested.
  const qualityRef = useRef(null);
  if (qualityRef.current === null) {
    qualityRef.current = new QualityController({
      onHeartbeat: (beat) => setLink(beat),
    });
  }

  // Keep the latest onDisconnect without rebuilding the RFB connection.
  useEffect(() => { onDisconnectRef.current = onDisconnect; }, [onDisconnect]);

  useEffect(() => {
    if (!url || !containerRef.current) { setState(url ? 'connecting' : 'idle'); return undefined; }
    setState('connecting');
    setBanner('');
    let rfb;
    try {
      rfb = new RFB(containerRef.current, url, {
        shared: true,
        viewOnly: viewOnly === true,
        scaleViewport: scale === 'fit',
        resizeSession: false, // keep the guest at 1280×800
        clipViewport: false,
      });
      rfb.focusOnClick = true;
      rfb.background = getComputedStyle(document.documentElement).getPropertyValue('--vnc-background').trim() || '#0b0d12';
    } catch (error) {
      setState('error');
      setBanner(String(error?.message ?? error));
      return undefined;
    }
    rfbRef.current = rfb;
    const live = liveRef.current;
    live.reset();
    const quality = qualityRef.current;
    quality.reset();
    quality.setConnected(false);

    // Liveness: every decoded framebuffer update proves the relay is alive.
    const origUpdate = typeof rfb._framebufferUpdate === 'function' ? rfb._framebufferUpdate.bind(rfb) : null;
    if (origUpdate) {
      rfb._framebufferUpdate = (...args) => {
        live.noteFrame();
        quality.noteFrame();
        return origUpdate(...args);
      };
    }

    // Input accounting: only *our* input proves the guest should have
    // repainted. A static screen with no input is healthy, not stalled.
    const noteInput = () => live.noteInput();
    const origSendKey = typeof rfb.sendKey === 'function' ? rfb.sendKey.bind(rfb) : null;
    if (origSendKey) {
      rfb.sendKey = (...args) => { noteInput(); quality.noteAction('key'); return origSendKey(...args); };
    }
    const origSendPointer = typeof rfb.sendPointerEvent === 'function' ? rfb.sendPointerEvent.bind(rfb) : null;
    if (origSendPointer) {
      rfb.sendPointerEvent = (...args) => { noteInput(); quality.noteAction('pointer'); return origSendPointer(...args); };
    }

    // The link we measure: every relay message is bytes on the wire. The
    // noVNC socket wrapper hides the raw WebSocket one level down.
    const sock = rfb._sock?._websocket ?? null;
    const onSockMessage = (ev) => {
      const bytes = ev?.data?.byteLength ?? 0;
      if (bytes > 0) quality.noteBytes(bytes, 1);
    };
    if (sock && typeof sock.addEventListener === 'function') {
      sock.addEventListener('message', onSockMessage);
    }

    const onConnect = () => {
      connectedRef.current = true;
      quality.setConnected(true);
      setState('connected');
      setBanner('');
    };
    const onDisconnect = (ev) => {
      connectedRef.current = false;
      quality.setConnected(false);
      setState('idle');
      if (ev?.detail?.clean === false) setBanner('Connection lost');
      onDisconnectRef.current?.();
    };
    const onSecurity = () => setState('error');
    const onCredentials = () => { try { rfb.sendCredentials({ password: '' }); } catch {} };
    const onClipboard = (ev) => {
      const text = ev?.detail?.text;
      if (typeof text === 'string' && text) {
        navigator.clipboard?.writeText(text).catch(() => {});
        setBanner('Guest clipboard copied');
        setTimeout(() => setBanner(''), 1500);
      }
    };
    rfb.addEventListener('connect', onConnect);
    rfb.addEventListener('disconnect', onDisconnect);
    rfb.addEventListener('securityfailure', onSecurity);
    rfb.addEventListener('credentialsrequired', onCredentials);
    rfb.addEventListener('clipboard', onClipboard);

    const watchdog = setInterval(() => {
      setFps(live.fps());
      if (!connectedRef.current) return;

      // A stall requires proof: we sent input and nothing was painted.
      const verdict = live.evaluate();
      if (verdict.dead) {
        setState('stalled');
        setBanner('Guest display stopped responding — reconnecting…');
        try { rfb.disconnect(); } catch {}
        setReconnectKey((k) => k + 1);
        return;
      }
      // Without input we cannot distinguish "idle" from "dead", so only
      // surface a hint — never tear the connection down.
      if (verdict.idle) {
        setBanner('Guest display is idle (no activity)');
        setTimeout(() => setBanner(''), 2000);
      }
    }, 2_000);

    // The link-quality controller: it samples the relay, keeps an EMA of the
    // bandwidth and moves the noVNC quality level when the estimate is
    // sustained on one side of a threshold. It also emits the liveness
    // beacon and reports whether the screen changed after our last action.
    const qualityTimer = setInterval(() => {
      quality.tick();
      const snapshot = quality.state();
      setLink(snapshot);
      const live2 = rfbRef.current;
      if (live2 && typeof live2.qualityLevel === 'number' && live2.qualityLevel !== snapshot.quality) {
        try { live2.qualityLevel = snapshot.quality; } catch { /* out of range: noVNC refuses it */ }
      }
    }, 1_000);

    return () => {
      clearInterval(watchdog);
      clearInterval(qualityTimer);
      if (sock && typeof sock.removeEventListener === 'function') {
        sock.removeEventListener('message', onSockMessage);
      }
      rfb.removeEventListener('connect', onConnect);
      rfb.removeEventListener('disconnect', onDisconnect);
      rfb.removeEventListener('securityfailure', onSecurity);
      rfb.removeEventListener('credentialsrequired', onCredentials);
      rfb.removeEventListener('clipboard', onClipboard);
      try { rfb.disconnect(); } catch {}
      rfbRef.current = null;
    };
  }, [url, viewOnly, scale, reconnectKey]);

  // macOS Cmd should behave like the guest's Super key, not a dead modifier.
  useEffect(() => {
    const node = containerRef.current;
    if (!node) return undefined;
    const onKeyDown = (e) => {
      if (viewOnly) return;
      const rfb = rfbRef.current;
      if (!rfb) return;
      if (e.key === 'Meta') {
        e.preventDefault();
        e.stopPropagation();
        rfb.sendKey(SUPER_L, 'MetaLeft', true);
        return;
      }
      if (e.metaKey && !e.ctrlKey && !e.altKey && e.key.length === 1 && !/^[a-z0-9]$/i.test(e.key)) {
        // Cmd+symbol → Super+symbol inside the guest.
        e.preventDefault();
        e.stopPropagation();
        metaChord(rfb, e.key);
      }
    };
    const onKeyUp = (e) => {
      if (e.key === 'Meta' && rfbRef.current) {
        e.preventDefault();
        e.stopPropagation();
        rfbRef.current.sendKey(SUPER_L, 'MetaLeft', false);
      }
    };
    node.addEventListener('keydown', onKeyDown, true);
    node.addEventListener('keyup', onKeyUp, true);
    return () => {
      node.removeEventListener('keydown', onKeyDown, true);
      node.removeEventListener('keyup', onKeyUp, true);
    };
  }, [viewOnly]);

  // IME mode: a hidden field owns composition; committed text goes as keysyms.
  useEffect(() => {
    const field = imeRef.current;
    if (!field) return undefined;
    if (ime) field.focus();
    const commit = () => {
      const text = field.value;
      if (!text) return;
      sendText(rfbRef.current, text);
      field.value = '';
    };
    const onKeyDown = (e) => {
      // Stop noVNC's document-level handler from double-typing while IME is on.
      e.stopPropagation();
      if (e.key === 'Enter') { e.preventDefault(); commit(); sendText(rfbRef.current, '\n'); }
    };
    field.addEventListener('compositionend', commit);
    field.addEventListener('input', commit);
    field.addEventListener('keydown', onKeyDown, true);
    return () => {
      field.removeEventListener('compositionend', commit);
      field.removeEventListener('input', commit);
      field.removeEventListener('keydown', onKeyDown, true);
    };
  }, [ime]);

  useEffect(() => {
    const onFs = () => setFullscreen(Boolean(document.fullscreenElement));
    document.addEventListener('fullscreenchange', onFs);
    return () => document.removeEventListener('fullscreenchange', onFs);
  }, []);

  const act = useCallback((fn) => { try { fn(rfbRef.current); } catch {} }, []);
  const pasteToGuest = useCallback(async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (!text) return;
      sendText(rfbRef.current, text);
      setBanner(`Sent ${text.length} chars to guest`);
    } catch (e) {
      setBanner('Clipboard access denied');
    }
    setTimeout(() => setBanner(''), 1600);
  }, []);
  const fullscreenToggle = useCallback(() => {
    const node = containerRef.current?.closest('.screen-viewer') ?? containerRef.current;
    if (!node) return;
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    else node.requestFullscreen?.().catch(() => {});
  }, []);

  if (!url) {
    return <div className="screen-viewer screen-viewer-idle" data-surface="screen-viewer"><span>Guest desktop not started</span></div>;
  }
  return (
    <div className="screen-viewer" data-surface="screen-viewer" data-state={state} data-scale={scale}>
      <div className="sv-toolbar" data-surface="screen-viewer-toolbar">
        <button type="button" title="Ctrl+Alt+Del" onClick={() => act((r) => sendChord(r, ['ControlLeft', 'AltLeft', 'Delete']))}>⌃⌥⌫</button>
        <button type="button" title="Alt+Tab" onClick={() => act((r) => sendChord(r, ['AltLeft', 'Tab']))}>⇥</button>
        <button type="button" title="Super (Meta)" onClick={() => act((r) => sendChord(r, ['SuperLeft']))}>⌘</button>
        <button type="button" title="Send local clipboard to guest" onClick={pasteToGuest}>Paste ▸</button>
        <button type="button" className={ime ? 'on' : ''} title="IME / CJK text mode" onClick={() => setIme((v) => !v)}>IME</button>
        <button type="button" title="Toggle fit / 1:1" onClick={() => setScale((s) => (s === 'fit' ? 'actual' : 'fit'))}>{scale === 'fit' ? '1:1' : 'Fit'}</button>
        <button type="button" title="Fullscreen" onClick={fullscreenToggle}>{fullscreen ? '⤡' : '⤢'}</button>
        <span className="sv-stats" title="Decoded framebuffer updates per second">{fps} fps</span>
        <span className="sv-metrics" data-surface="screen-viewer-link">
          <span className="sv-metric" title="Measured link bandwidth (EMA) and the noVNC quality level it drives">
            Q{link.quality} · {link.bandwidthMbps > 0 ? `${link.bandwidthMbps.toFixed(1)} Mbps` : 'no estimate'}
          </span>
          <span className="sv-metric" title="How long since the guest last painted">
            {link.lastSeenAgeMs === null ? 'no signal' : `seen ${Math.round(link.lastSeenAgeMs / 1000)}s ago`}
          </span>
          {link.stuck ? (
            <span className="sv-metric sv-warn" title="We sent input and the screen did not change">
              screen did not change
            </span>
          ) : null}
        </span>
      </div>
      {state !== 'connected' && (
        <div className="screen-viewer-status">
          {state === 'connecting' ? 'Connecting…' : state === 'error' ? 'Connection error' : state === 'stalled' ? 'Display stalled' : 'Idle'}
          {banner ? <span className="sv-banner"> — {banner}</span> : null}
        </div>
      )}
      {state === 'connected' && banner ? <div className="sv-banner sv-banner-float">{banner}</div> : null}
      <div className="screen-viewer-canvas" ref={containerRef} tabIndex={0} />
      <input
        ref={imeRef}
        className={`sv-ime${ime ? ' on' : ''}`}
        aria-label="IME text input"
        autoComplete="off"
        spellCheck={false}
        onChange={() => {}}
      />
    </div>
  );
}
