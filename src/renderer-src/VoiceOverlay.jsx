import React, { useCallback, useEffect, useRef, useState } from 'react';
import { api, events, toast } from './lib.js';
import { Icon } from './Icons.jsx';
import { createMicCapture } from './voice-loop.js';

/**
 * The voice overlay — a full-duplex voice loop.
 *
 * While it is open the microphone is live: what you say is transcribed
 * locally and sent to the agent as it is finished, and the agent's replies
 * are spoken back sentence by sentence. Start talking while the agent is
 * speaking and the playback is cut off immediately.
 */
export function VoiceOverlay({ sessionId, onSend, onClose }) {
  const [state, setState] = useState('idle');       // idle | listening | speaking | error
  const [level, setLevel] = useState(0);
  const [lines, setLines] = useState([]);
  const [error, setError] = useState(null);
  const tokenRef = useRef(null);
  const captureRef = useRef(null);
  const linesRef = useRef([]);

  const pushLine = useCallback((kind, text) => {
    const line = { kind, text, id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}` };
    linesRef.current = [...linesRef.current, line].slice(-40);
    setLines(linesRef.current);
  }, []);

  // the main-process events
  useEffect(() => {
    const offState = events.on('voiceSession', 'state', (payload) => {
      if (payload?.token !== tokenRef.current) return;
      setState(payload.speaking ? 'speaking' : 'listening');
    });
    const offTranscript = events.on('voiceSession', 'transcript', (payload) => {
      if (payload?.token !== tokenRef.current) return;
      if (!payload.text) return;
      pushLine('user', payload.text);
      onSend?.(payload.text);
    });
    const offSpeaking = events.on('voiceSession', 'speaking', (payload) => {
      if (payload?.token !== tokenRef.current) return;
      if (payload.done) pushLine('agent', payload.text);
    });
    const offInterrupted = events.on('voiceSession', 'interrupted', (payload) => {
      if (payload?.token !== tokenRef.current) return;
      pushLine('note', 'interrupted');
    });
    return () => { offState?.(); offTranscript?.(); offSpeaking?.(); offInterrupted?.(); };
  }, [onSend, pushLine]);

  const stop = useCallback(async () => {
    captureRef.current?.stop();
    captureRef.current = null;
    if (tokenRef.current) {
      try { await api.voiceSession.stop({ token: tokenRef.current }); } catch { /* already gone */ }
    }
    tokenRef.current = null;
    setState('idle');
  }, []);

  const start = useCallback(async () => {
    setError(null);
    try {
      const started = await api.voiceSession.start({ sessionId });
      tokenRef.current = started.token;
      setState('listening');
      const capture = await createMicCapture({
        onFrame: (pcm) => {
          const token = tokenRef.current;
          if (!token) return;
          api.voiceSession.push({ token, pcmBase64: pcm }).catch(() => {});
        },
        onLevel: setLevel,
      });
      captureRef.current = capture;
    } catch (failure) {
      setError(failure.message);
      setState('error');
      toast(failure.message, 'err');
    }
  }, [sessionId]);

  // The agent's replies are spoken while the overlay is open.
  useEffect(() => {
    const handler = (event) => {
      const token = tokenRef.current;
      if (!token) return;
      const text = event?.detail?.text;
      if (text) api.voiceSession.speak({ token, text }).catch(() => {});
    };
    window.addEventListener('quansiox:voice-reply', handler);
    return () => window.removeEventListener('quansiox:voice-reply', handler);
  }, []);

  useEffect(() => () => { captureRef.current?.stop(); }, []);

  return (
    <div className="voice-overlay" data-surface="voice-overlay">
      <div className="voice-head">
        <span className={`voice-dot voice-${state}`} />
        <span className="voice-state">
          {state === 'listening' ? 'Listening — speak now'
            : state === 'speaking' ? 'Speaking — talk to interrupt'
              : state === 'error' ? 'Microphone unavailable'
                : 'Ready'}
        </span>
        <span style={{ flex: 1 }} />
        <button className="ibtn" title="Close" onClick={() => { stop(); onClose?.(); }}><Icon.X /></button>
      </div>
      <div className="voice-meter" title="microphone level">
        <span className="voice-meter-fill" style={{ width: `${Math.round(level * 100)}%` }} />
      </div>
      {error && <div className="voice-error">{error}</div>}
      <div className="voice-lines">
        {lines.map((line) => (
          <div key={line.id} className={`voice-line voice-line-${line.kind}`}>{line.text}</div>
        ))}
        {lines.length === 0 && <div className="voice-empty">Your words and the agent's replies appear here.</div>}
      </div>
      <div className="voice-actions">
        {state === 'idle' || state === 'error'
          ? <button className="btn primary" onClick={start}>Start talking</button>
          : <button className="btn" onClick={stop}>Stop</button>}
      </div>
    </div>
  );
}
