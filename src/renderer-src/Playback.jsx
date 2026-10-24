import { useCallback, useEffect, useRef, useState } from 'react';
import { api, events } from './lib.js';
import { Icon } from './Icons.jsx';

/**
 * Session playback window (Cue's computer:playback, on local recordings):
 * steps through the screenshots the agent took during a run — play/pause,
 * prev/next, timeline scrub, fullscreen, and live mode while the agent is
 * still taking screenshots.
 */
export default function Playback({ sessionId }) {
  const [frames, setFrames] = useState([]);
  const [total, setTotal] = useState(0);
  const [index, setIndex] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const timer = useRef(null);
  const framesLen = useRef(0); // live-edge cursor for incremental fetches

  const loadFrames = useCallback(async (from = 0) => {
    try {
      const r = await api.playback.frames({ sessionId, from });
      setTotal(r.total);
      framesLen.current = r.total;
      setFrames((prev) => {
        const merged = from === 0 ? r.frames : [...prev, ...r.frames];
        return merged;
      });
      return r;
    } catch {
      return null;
    }
  }, [sessionId]);

  useEffect(() => {
    setFrames([]);
    setIndex(0);
    loadFrames(0);
  }, [loadFrames]);

  // Live mode: while a run is in flight, new screenshots stream in.
  useEffect(() => {
    const offs = [
      events.on('playback', 'onFrame', (sid) => {
        if (sid !== sessionId) return;
        const from = framesLen.current;
        loadFrames(from).then((r) => {
          // Follow the live edge while playing (or parked at the last frame).
          setIndex((i) => (playing || i >= from - 1 ? Math.max(0, (r?.total ?? from) - 1) : i));
        });
      }),
      events.on('updater', 'onPrepareRestart', ({ id }) => {
        // Nothing to flush in a viewer — ack immediately (Cue handshake).
        api.updater.prepared({ id, result: 'ok' }).catch(() => {});
      }),
    ];
    return () => offs.forEach((off) => off());
  }, [sessionId, total, playing, loadFrames]);

  // Play loop: advance ~1 frame/second.
  useEffect(() => {
    if (!playing) return;
    timer.current = setInterval(() => {
      setIndex((i) => {
        if (i >= frames.length - 1) {
          setPlaying(false);
          return i;
        }
        return i + 1;
      });
    }, 1000);
    return () => clearInterval(timer.current);
  }, [playing, frames.length]);

  const current = frames[Math.min(index, frames.length - 1)];

  const toggleFullscreen = useCallback(async () => {
    try {
      setFullscreen(Boolean(await api.playback.fullscreen()));
    } catch {}
  }, []);

  // Keyboard: arrows / space / f (also usable in fullscreen).
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'ArrowRight') setIndex((i) => Math.min(i + 1, Math.max(0, frames.length - 1)));
      else if (e.key === 'ArrowLeft') setIndex((i) => Math.max(0, i - 1));
      else if (e.key === ' ') { e.preventDefault(); setPlaying((p) => !p); }
      else if (e.key === 'f') toggleFullscreen();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [frames.length, toggleFullscreen]);

  return (
    <div className={`playback${fullscreen ? ' fullscreen' : ''}`}>
      <header className="playback-header">
        <span className="playback-title"><Icon.Play /> Run recording — {sessionId}</span>
        <span className="playback-counter">{frames.length ? `${index + 1} / ${frames.length}` : 'no frames yet'}</span>
      </header>
      <div className="playback-stage">
        {current
          ? <img className="playback-frame" src={current.dataUrl} alt={`frame ${current.index}`}
            onLoad={(e) => {
              // Fit-to-content on the first frame (Cue computer:fit).
              if (frames.length === 1 && index === 0) {
                api.playback.fit({ width: e.target.naturalWidth, height: e.target.naturalHeight }).catch(() => {});
              }
            }} />
          : <div className="playback-empty">
              No recorded screenshots for this session yet.<br />
              <span className="mono">Frames appear when the agent uses computer_screenshot.</span>
            </div>}
      </div>
      <footer className="playback-controls">
        <button className="btn btn-secondary btn-mini" onClick={() => setIndex((i) => Math.max(0, i - 1))}
          disabled={!frames.length} title="Previous"><Icon.SkipBack /></button>
        <button className="btn btn-primary btn-mini" onClick={() => setPlaying((p) => !p)}
          disabled={!frames.length}>{playing ? <><Icon.Pause /> Pause</> : <><Icon.Play /> Play</>}</button>
        <button className="btn btn-secondary btn-mini"
          onClick={() => setIndex((i) => Math.min(i + 1, frames.length - 1))} disabled={!frames.length} title="Next"><Icon.SkipFwd /></button>
        <input className="playback-slider" type="range" min={0} max={Math.max(0, frames.length - 1)}
          value={Math.min(index, Math.max(0, frames.length - 1))}
          onChange={(e) => { setPlaying(false); setIndex(Number(e.target.value)); }} disabled={!frames.length} />
        <button className="btn btn-secondary btn-mini" onClick={toggleFullscreen}
          title="Toggle fullscreen (f)"><Icon.Expand /> {fullscreen ? 'Exit' : 'Fullscreen'}</button>
      </footer>
    </div>
  );
}
