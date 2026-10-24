import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Icon } from './Icons.jsx';
import { api, toast } from './lib.js';
import { downsample, isCapturing, memoClock, voiceMemoReducer } from './composerModel.js';

/**
 * VoiceMemoBar (parity plan P2.3) — Grok's voice memo, local-first.
 *
 * Records AAC-in-MP4 (MediaRecorder, mp4a.40.2 when supported), pause and
 * resume included, with a live waveform drawn from the analyser's peak
 * history. On stop the take becomes a normal attachment (the existing
 * attachments pipeline) and the local transcriber is asked for a transcript
 * — best-effort: without a local STT provider the memo still attaches, the
 * transcript is simply not inserted (the voice service is honest about
 * being unavailable; nothing pretends to transcribe).
 */

const WAVE_BARS = 48;

export default function VoiceMemoBar({ onMemo, onTranscript, onClose }) {
  const [state, setState] = useState('idle');
  const [elapsed, setElapsed] = useState(0);
  const [error, setError] = useState('');
  const reducerRef = useRef(null);
  const recorderRef = useRef(null);
  const streamRef = useRef(null);
  const audioRef = useRef(null);   // AudioContext
  const analyserRef = useRef(null);
  const rafRef = useRef(null);
  const chunksRef = useRef([]);
  const peaksRef = useRef([]);
  const canvasRef = useRef(null);
  const startedAtRef = useRef(0);
  const accumulatedRef = useRef(0); // ms recorded before the current run (pause support)

  const dispatch = useCallback((event) => {
    setState((cur) => {
      const next = voiceMemoReducer(cur, event);
      reducerRef.current = next;
      return next;
    });
  }, []);

  const stopAnalyser = useCallback(() => {
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    rafRef.current = null;
  }, []);

  const drawWave = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const bars = downsample(peaksRef.current, WAVE_BARS);
    const { width, height } = canvas;
    ctx.clearRect(0, 0, width, height);
    const style = getComputedStyle(canvas);
    ctx.fillStyle = style.color || 'currentColor';
    const barW = width / WAVE_BARS;
    for (let i = 0; i < WAVE_BARS; i += 1) {
      const h = Math.max(1, bars[i] * (height - 2));
      ctx.fillRect(i * barW + 0.5, (height - h) / 2, Math.max(1, barW - 1.5), h);
    }
  }, []);

  const teardownAudio = useCallback(() => {
    stopAnalyser();
    try { audioRef.current?.close(); } catch { /* already closed */ }
    audioRef.current = null;
    analyserRef.current = null;
    streamRef.current?.getTracks?.().forEach((t) => t.stop());
    streamRef.current = null;
    recorderRef.current = null;
  }, []);

  useEffect(() => () => teardownAudio(), [teardownAudio]);

  // The elapsed clock ticks only while capturing (pause freezes it).
  useEffect(() => {
    if (!isCapturing(state)) return;
    const timer = setInterval(() => {
      setElapsed(accumulatedRef.current + (performance.now() - startedAtRef.current));
    }, 250);
    return () => clearInterval(timer);
  }, [state]);

  const start = useCallback(async () => {
    setError('');
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
      setError('Recording is unavailable in this environment');
      dispatch('error');
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      const mime = MediaRecorder.isTypeSupported('audio/mp4;codecs=mp4a.40.2')
        ? 'audio/mp4;codecs=mp4a.40.2'
        : (MediaRecorder.isTypeSupported('audio/mp4') ? 'audio/mp4' : undefined);
      const rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
      recorderRef.current = rec;
      chunksRef.current = [];
      peaksRef.current = [];
      accumulatedRef.current = 0;
      rec.ondataavailable = (ev) => { if (ev.data?.size) chunksRef.current.push(ev.data); };
      rec.start(250);

      const audio = new AudioContext();
      audioRef.current = audio;
      const analyser = audio.createAnalyser();
      analyser.fftSize = 512;
      analyserRef.current = analyser;
      audio.createMediaStreamSource(stream).connect(analyser);
      const buf = new Uint8Array(analyser.frequencyBinCount);
      const sample = () => {
        if (analyserRef.current !== analyser) return;
        analyser.getByteTimeDomainData(buf);
        let peak = 0;
        for (let i = 0; i < buf.length; i += 1) peak = Math.max(peak, Math.abs(buf[i] - 128) / 128);
        peaksRef.current.push(peak);
        if (peaksRef.current.length > 4000) peaksRef.current.splice(0, peaksRef.current.length - 4000);
        drawWave();
        rafRef.current = requestAnimationFrame(sample);
      };
      startedAtRef.current = performance.now();
      rafRef.current = requestAnimationFrame(sample);
      dispatch('start');
    } catch (err) {
      setError(err?.name === 'NotAllowedError' ? 'Microphone permission denied' : 'Microphone unavailable');
      teardownAudio();
      dispatch('error');
    }
  }, [dispatch, drawWave, teardownAudio]);

  const onPauseResume = useCallback(() => {
    const rec = recorderRef.current;
    if (!rec) return;
    if (state === 'recording') {
      rec.pause();
      stopAnalyser();
      accumulatedRef.current += performance.now() - startedAtRef.current;
      dispatch('pause');
    } else if (state === 'paused') {
      rec.resume();
      startedAtRef.current = performance.now();
      const analyser = analyserRef.current;
      const buf = new Uint8Array(analyser?.frequencyBinCount ?? 256);
      const sample = () => {
        if (!analyserRef.current) return;
        analyserRef.current.getByteTimeDomainData(buf);
        let peak = 0;
        for (let i = 0; i < buf.length; i += 1) peak = Math.max(peak, Math.abs(buf[i] - 128) / 128);
        peaksRef.current.push(peak);
        drawWave();
        rafRef.current = requestAnimationFrame(sample);
      };
      rafRef.current = requestAnimationFrame(sample);
      dispatch('resume');
    }
  }, [dispatch, drawWave, state, stopAnalyser]);

  const finalize = useCallback(async () => {
    const rec = recorderRef.current;
    const finalizeState = state;
    if (!rec) { dispatch('reset'); return; }
    const mime = rec.mimeType || 'audio/webm';
    const done = new Promise((resolve) => { rec.onstop = () => resolve(); });
    rec.stop();
    await done;
    if (finalizeState === 'recording') accumulatedRef.current += performance.now() - startedAtRef.current;
    const durationMs = Math.round(accumulatedRef.current);
    const blob = new Blob(chunksRef.current, { type: mime });
    teardownAudio();
    dispatch('stop');

    const ext = mime.includes('mp4') ? 'm4a' : 'webm';
    const file = new File([blob], `voice-memo.${ext}`, { type: mime.split(';')[0] });
    try {
      await onMemo?.(file, { durationMs });
    } catch (err) {
      toast(`voice memo: ${err?.message ?? err}`, 'err');
    }

    // Transcript is best-effort and strictly local (the voice service says
    // no honestly when no provider is configured).
    try {
      const audioBase64 = await new Promise((res, rej) => {
        const r = new FileReader();
        r.onload = () => res(String(r.result).split(',')[1] || '');
        r.onerror = rej;
        r.readAsDataURL(blob);
      });
      const out = await api.voice.transcribe({ audioBase64, mimeType: mime.split(';')[0] });
      const text = String(out?.text ?? '').trim();
      if (text) {
        onTranscript?.(text);
        toast('transcript inserted below the memo', 'ok');
      }
    } catch { /* no local transcriber configured — the memo itself already attached */ }
  }, [dispatch, onMemo, onTranscript, state, teardownAudio]);

  const onCancel = useCallback(() => {
    try { recorderRef.current?.state !== 'inactive' && recorderRef.current?.stop(); } catch { /* already stopped */ }
    teardownAudio();
    peaksRef.current = [];
    setElapsed(0);
    setError('');
    dispatch('cancel');
    drawWave();
  }, [dispatch, drawWave, teardownAudio]);

  const reset = useCallback(() => {
    setElapsed(0);
    setError('');
    dispatch('reset');
    peaksRef.current = [];
    drawWave();
  }, [dispatch, drawWave]);

  return (
    <div className="voice-bar" data-surface="voice-bar" data-state={state} role="group" aria-label="Voice memo">
      {state === 'idle' ? (
        <>
          <button type="button" className="cbtn voice-record" data-surface="voice-record" onClick={start}
            title="Record a voice memo" aria-label="Record voice memo"><Icon.Mic /></button>
          <span className="voice-bar-hint">Record a voice memo — it attaches to the next message</span>
          <button type="button" className="cbtn" onClick={onClose} title="Hide voice memo bar" aria-label="Hide"><Icon.X /></button>
        </>
      ) : null}
      {state === 'error' ? (
        <>
          <span className="voice-error" data-surface="voice-error">{error || 'Recording failed'}</span>
          <button type="button" className="cbtn" onClick={reset} title="Dismiss" aria-label="Dismiss"><Icon.X /></button>
        </>
      ) : null}
      {(state === 'recording' || state === 'paused') ? (
        <>
          <span className={`voice-state-dot${state === 'recording' ? ' live' : ''}`} data-state={state} aria-hidden="true" />
          <canvas ref={canvasRef} className="voice-wave" width={220} height={26} data-surface="voice-wave" aria-label="Waveform" />
          <span className="voice-clock" data-surface="voice-clock">{memoClock(elapsed)}</span>
          <button type="button" className="cbtn" data-surface="voice-pause" onClick={onPauseResume}
            title={state === 'recording' ? 'Pause' : 'Resume'} aria-label={state === 'recording' ? 'Pause' : 'Resume'}>
            {state === 'recording' ? <Icon.Pause /> : <Icon.Play />}
          </button>
          <button type="button" className="cbtn" data-surface="voice-stop" onClick={finalize} title="Stop and attach" aria-label="Stop and attach"><Icon.Check /></button>
          <button type="button" className="cbtn" data-surface="voice-cancel" onClick={onCancel} title="Discard recording" aria-label="Discard recording"><Icon.Trash /></button>
        </>
      ) : null}
      {state === 'stopped' ? (
        <>
          <Icon.Check />
          <span className="voice-bar-hint">Memo attached ({memoClock(elapsed)})</span>
          <button type="button" className="cbtn" onClick={reset} title="Record another" aria-label="Record another"><Icon.Mic /></button>
          <button type="button" className="cbtn" onClick={onClose} title="Hide voice memo bar" aria-label="Hide"><Icon.X /></button>
        </>
      ) : null}
    </div>
  );
}
