'use strict';
/**
 * Microphone capture for the voice loop.
 *
 * The renderer grabs the raw microphone stream, downsamples it to 16 kHz
 * mono 16-bit PCM and hands 20 ms frames to the main process, which does
 * the voice-activity detection and the transcription.
 *
 * Downsampling is a plain linear resample: it is not a filter, but at 16 kHz
 * the speech recogniser is happy with it and it keeps the app free of a
 * heavy audio dependency.
 */

/** Resample Float32 samples to a target rate (linear interpolation). */
export function resample(samples, fromRate, toRate) {
  if (!samples || !samples.length || fromRate === toRate) return samples;
  const ratio = fromRate / toRate;
  const length = Math.floor(samples.length / ratio);
  const out = new Float32Array(length);
  for (let i = 0; i < length; i += 1) {
    const position = i * ratio;
    const index = Math.floor(position);
    const frac = position - index;
    const a = samples[index] ?? 0;
    const b = samples[index + 1] ?? a;
    out[i] = a + (b - a) * frac;
  }
  return out;
}

/** Float32 [-1, 1] samples -> a base64 16-bit PCM string. */
export function floatToBase64Pcm(samples) {
  const buffer = new ArrayBuffer(samples.length * 2);
  const view = new DataView(buffer);
  for (let i = 0; i < samples.length; i += 1) {
    const clamped = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(i * 2, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true);
  }
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/**
 * Start capturing the microphone.
 *
 * @param {object} opts
 * @param {(pcmBase64: string) => void} opts.onFrame   called with each frame
 * @param {(level: number) => void} [opts.onLevel]      0..1 microphone level
 * @param {number} [opts.targetRate]                    16000
 * @param {number} [opts.frameMs]                       20
 * @returns {Promise<{ stop: () => void, sampleRate: number }>}
 */
export async function createMicCapture({ onFrame, onLevel, targetRate = 16000, frameMs = 20 } = {}) {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error('this browser cannot capture the microphone');
  }
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      channelCount: 1,
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    },
  });
  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextClass) {
    stream.getTracks().forEach((track) => track.stop());
    throw new Error('this browser has no Web Audio support');
  }
  const context = new AudioContextClass();
  const source = context.createMediaStreamSource(stream);
  const processor = context.createScriptProcessor(4096, 1, 1);
  const fromRate = context.sampleRate;
  const samplesPerFrame = Math.round((fromRate * frameMs) / 1000);

  let stopped = false;
  let pending = [];

  processor.onaudioprocess = (event) => {
    if (stopped) return;
    const input = event.inputBuffer.getChannelData(0);
    pending.push(...input);
    while (pending.length >= samplesPerFrame) {
      const slice = pending.splice(0, samplesPerFrame);
      const resampled = resample(Float32Array.from(slice), fromRate, targetRate);
      let sum = 0;
      for (let i = 0; i < resampled.length; i += 1) sum += resampled[i] * resampled[i];
      const rms = Math.sqrt(sum / Math.max(1, resampled.length));
      onLevel?.(Math.min(1, rms * 4));
      onFrame?.(floatToBase64Pcm(resampled));
    }
  };

  source.connect(processor);
  // A zero-gain sink keeps the processor running without echoing the mic.
  const sink = context.createGain();
  sink.gain.value = 0;
  processor.connect(sink);
  sink.connect(context.destination);

  return {
    sampleRate: targetRate,
    stop() {
      if (stopped) return;
      stopped = true;
      try { processor.onaudioprocess = null; } catch { /* already gone */ }
      try { source.disconnect(); processor.disconnect(); sink.disconnect(); } catch { /* already gone */ }
      try { stream.getTracks().forEach((track) => track.stop()); } catch { /* already gone */ }
      try { context.close(); } catch { /* already gone */ }
    },
  };
}
