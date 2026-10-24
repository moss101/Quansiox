'use strict';
/**
 * Multimedia — the local-first implementation of Manus' multimedia surface.
 *
 * The documented surface is wide (image generation, image understanding,
 * OCR, image comparison, video understanding, speech, transcription,
 * diarization, video generation). What this module owns is the part that can
 * be done **honestly on the user's own Mac**:
 *
 *   - **OCR** — through the macOS Vision framework (`QuansioxVision`), no
 *     model download, no network;
 *   - **batch OCR** — many images into one table (the docs' "batch OCR
 *     across 10 images into a spreadsheet");
 *   - **image analysis** — a real histogram, dominant colours and a
 *     perceptual comparison of two images, so "what differs between these
 *     two pictures" has a factual answer even without a vision model;
 *   - **video** — real frame extraction and probing through `ffmpeg`, and
 *     real video *generation* from a set of frames;
 *   - **speech** — the system voice with a real tone / pace / style system.
 *
 * Where the work genuinely needs a model (a caption, a "describe this
 * picture" answer), the module does not fake it: the agent tool sends the
 * image to the model the user already configured, and says plainly when no
 * model or no `ffmpeg` is available.
 */
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');

const imageOps = require('../../shared/imageOps');

/* ------------------------------------------------------------------ tools */

/**
 * Where the OCR helper lives.
 *
 * In the source tree it is built into `build/`; in the packaged app the
 * packaging step installs it into `native/` (the same place the computer
 * helper and the capture helper go). Both are checked, so the feature works
 * in development *and* in the shipped bundle — checking only one of them is
 * how OCR ends up silently unavailable in the app the user actually runs.
 */
function visionHelperPath() {
  const root = path.join(__dirname, '..', '..', '..');
  for (const directory of ['build', 'native']) {
    const candidate = path.join(root, directory, 'QuansioxVision');
    if (fs.existsSync(candidate)) return candidate;
  }
  return path.join(root, 'build', 'QuansioxVision');
}

function visionAvailable() {
  try {
    return fs.existsSync(visionHelperPath());
  } catch {
    return false;
  }
}

function ffmpegPath() {
  for (const candidate of ['/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg', '/usr/bin/ffmpeg']) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function ffprobePath() {
  for (const candidate of ['/opt/homebrew/bin/ffprobe', '/usr/local/bin/ffprobe', '/usr/bin/ffprobe']) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

/* --------------------------------------------------------------------- OCR */

/**
 * Recognise text in an image.
 *
 * @returns {{ok: boolean, width: number, height: number, blocks: Array, text: string, reason?: string}}
 */
function ocrImage(imagePath) {
  const helper = visionHelperPath();
  if (!fs.existsSync(helper)) {
    return { ok: false, reason: 'the local OCR helper is not built — run `npm run native`', blocks: [], text: '' };
  }
  if (!fs.existsSync(imagePath)) {
    return { ok: false, reason: `no such image: ${imagePath}`, blocks: [], text: '' };
  }
  const result = spawnSync(helper, ['ocr', imagePath], { encoding: 'utf8', timeout: 60_000 });
  if (result.error) {
    return { ok: false, reason: `OCR helper failed: ${result.error.message}`, blocks: [], text: '' };
  }
  let parsed = null;
  try {
    parsed = JSON.parse(String(result.stdout || '').trim());
  } catch {
    parsed = null;
  }
  if (!parsed) {
    const stderr = String(result.stderr || '').trim();
    return { ok: false, reason: stderr || `OCR helper exited ${result.status}`, blocks: [], text: '' };
  }
  if (!parsed.ok) {
    return { ok: false, reason: parsed.error ?? 'no text found', width: parsed.width, height: parsed.height, blocks: [], text: '' };
  }
  return {
    ok: true,
    width: parsed.width,
    height: parsed.height,
    blocks: parsed.blocks ?? [],
    text: (parsed.blocks ?? []).map((b) => b.text).join('\n'),
  };
}

/**
 * OCR a set of images and lay the results out as a table (MUL-23).
 *
 * @returns {{ok: boolean, columns: string[], rows: Array}}
 */
function ocrBatch(imagePaths = []) {
  const rows = [];
  for (const imagePath of imagePaths) {
    const result = ocrImage(imagePath);
    rows.push({
      file: path.basename(imagePath),
      path: imagePath,
      ok: result.ok,
      text: result.text,
      blocks: (result.blocks ?? []).length,
      reason: result.reason ?? null,
    });
  }
  const columns = ['file', 'ok', 'blocks', 'text'];
  return { ok: rows.some((r) => r.ok), columns, rows };
}

/* ------------------------------------------------------------ image analysis */

/** The histogram and dominant colours of an image. */
function analyzeImage(imagePath) {
  let decoded;
  try {
    const buffer = fs.readFileSync(imagePath);
    decoded = imageOps.decodePNG(buffer);
  } catch (error) {
    // A non-PNG image is converted by the renderer first; if it still is not
    // a PNG we say so instead of guessing.
    return { ok: false, reason: `cannot decode ${path.basename(imagePath)} as PNG: ${error.message}` };
  }
  const buckets = 16;
  const histogram = new Array(buckets * buckets * buckets).fill(0);
  const colourCounts = new Map();
  let total = 0;
  for (let y = 0; y < decoded.height; y += 1) {
    for (let x = 0; x < decoded.width; x += 1) {
      const [r, g, b, a] = imageOps.getPixel(decoded, x, y);
      if (a < 8) continue;
      total += 1;
      const key = (Math.floor(r / 16) << 8) | (Math.floor(g / 16) << 4) | Math.floor(b / 16);
      histogram[key] += 1;
      const hex = `#${[r, g, b].map((c) => c.toString(16).padStart(2, '0')).join('')}`;
      colourCounts.set(hex, (colourCounts.get(hex) ?? 0) + 1);
    }
  }
  const dominant = [...colourCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([colour, count]) => ({ colour, share: total ? count / total : 0 }));
  // Luminance summary.
  let lumaSum = 0;
  let lumaSquared = 0;
  for (let y = 0; y < decoded.height; y += 1) {
    for (let x = 0; x < decoded.width; x += 1) {
      const [r, g, b, a] = imageOps.getPixel(decoded, x, y);
      if (a < 8) continue;
      const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      lumaSum += luma;
      lumaSquared += luma * luma;
    }
  }
  const mean = total ? lumaSum / total : 0;
  const variance = total ? lumaSquared / total - mean * mean : 0;
  return {
    ok: true,
    width: decoded.width,
    height: decoded.height,
    pixels: total,
    dominant,
    brightness: mean / 255,
    contrast: Math.sqrt(Math.max(0, variance)) / 255,
    histogram: histogram.map((count) => (total ? count / total : 0)),
  };
}

/**
 * Compare two images: the factual part (how different they are, where) is
 * computed here; the descriptive part is the model's job.
 */
function compareImages(aPath, bPath) {
  const a = analyzeImage(aPath);
  const b = analyzeImage(bPath);
  if (!a.ok) return { ok: false, reason: a.reason };
  if (!b.ok) return { ok: false, reason: b.reason };
  let pixelDelta = null;
  try {
    const decodedA = imageOps.decodePNG(fs.readFileSync(aPath));
    const decodedB = imageOps.decodePNG(fs.readFileSync(bPath));
    const diff = imageOps.difference(decodedA, decodedB);
    pixelDelta = diff.meanDelta;
  } catch { /* the sizes or the formats differ — the rest still holds */ }
  const brightnessDelta = Math.abs((a.brightness ?? 0) - (b.brightness ?? 0));
  const shared = a.dominant.filter((entry) => b.dominant.some((other) => other.colour === entry.colour));
  return {
    ok: true,
    a: { width: a.width, height: a.height, dominant: a.dominant },
    b: { width: b.width, height: b.height, dominant: b.dominant },
    meanPixelDelta: pixelDelta,
    brightnessDelta,
    sharedColours: shared.map((entry) => entry.colour),
    identical: pixelDelta === 0,
  };
}

/* ------------------------------------------------------------------ video */

/** Probe a video file: duration, dimensions, frame rate, streams. */
function probeVideo(videoPath) {
  const probe = ffprobePath();
  if (!probe) return { ok: false, reason: 'ffprobe is not installed — install ffmpeg to work with video' };
  if (!fs.existsSync(videoPath)) return { ok: false, reason: `no such file: ${videoPath}` };
  const result = spawnSync(probe, [
    '-v', 'quiet', '-print_format', 'json', '-show_format', '-show_streams', videoPath,
  ], { encoding: 'utf8', timeout: 30_000 });
  if (result.status !== 0) return { ok: false, reason: `ffprobe exited ${result.status}` };
  let parsed = null;
  try { parsed = JSON.parse(result.stdout); } catch { parsed = null; }
  if (!parsed) return { ok: false, reason: 'ffprobe produced no output' };
  const video = (parsed.streams ?? []).find((s) => s.codec_type === 'video');
  const audio = (parsed.streams ?? []).find((s) => s.codec_type === 'audio');
  const duration = Number(parsed.format?.duration ?? video?.duration ?? 0);
  const frameRate = String(video?.avg_frame_rate ?? '0/1').split('/');
  return {
    ok: true,
    path: videoPath,
    durationSeconds: duration,
    width: video?.width ?? null,
    height: video?.height ?? null,
    frameRate: frameRate.length === 2 ? Number(frameRate[1]) ? Number(frameRate[0]) / Number(frameRate[1]) : 0 : 0,
    hasAudio: Boolean(audio),
    videoCodec: video?.codec_name ?? null,
    audioCodec: audio?.codec_name ?? null,
    sizeBytes: Number(parsed.format?.size ?? 0),
  };
}

/**
 * Extract frames from a video — the raw material for understanding it.
 *
 * The frames are sampled evenly with the `fps` filter rather than by seeking
 * to a timestamp: seeking to the very end of a clip often yields nothing,
 * while a rate-based sample always produces the frames it promised.
 *
 * @returns {{ok: boolean, frames: Array<{path: string, index: number, timestamp: number}>, reason?: string}}
 */
function extractFrames(videoPath, { count = 8, outputDir } = {}) {
  const ffmpeg = ffmpegPath();
  if (!ffmpeg) return { ok: false, reason: 'ffmpeg is not installed — install ffmpeg to work with video', frames: [] };
  if (!fs.existsSync(videoPath)) return { ok: false, reason: `no such file: ${videoPath}`, frames: [] };
  const info = probeVideo(videoPath);
  if (!info.ok) return { ok: false, reason: info.reason, frames: [] };
  const dir = outputDir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'qx-frames-'));
  fs.mkdirSync(dir, { recursive: true });
  for (const file of fs.readdirSync(dir)) {
    if (file.startsWith('frame-')) fs.rmSync(path.join(dir, file), { force: true });
  }
  const duration = Math.max(0.1, info.durationSeconds || 1);
  const wanted = Math.max(1, Math.min(120, Math.round(count)));
  const pattern = path.join(dir, 'frame-%03d.png');
  const rate = wanted / duration;
  const result = spawnSync(ffmpeg, [
    '-y', '-i', videoPath,
    '-vf', `fps=${rate.toFixed(6)}`,
    '-frames:v', String(wanted),
    pattern,
  ], { encoding: 'utf8', timeout: 120_000 });

  const frames = [];
  if (result.status === 0) {
    for (let index = 0; index < wanted; index += 1) {
      const file = path.join(dir, `frame-${String(index + 1).padStart(3, '0')}.png`);
      if (!fs.existsSync(file)) break;
      frames.push({
        path: file,
        index,
        timestamp: Number(((index + 0.5) * duration / wanted).toFixed(2)),
      });
    }
  }
  if (!frames.length) {
    // Fall back to seeking, which works for formats the fps filter rejects.
    for (let index = 0; index < wanted; index += 1) {
      const timestamp = duration * (index + 0.5) / wanted;
      const file = path.join(dir, `frame-${String(index + 1).padStart(3, '0')}.png`);
      const seek = spawnSync(ffmpeg, [
        '-y', '-ss', String(timestamp), '-i', videoPath,
        '-frames:v', '1', '-f', 'image2', file,
      ], { encoding: 'utf8', timeout: 60_000 });
      if (seek.status === 0 && fs.existsSync(file)) {
        frames.push({ path: file, index, timestamp: Number(timestamp.toFixed(2)) });
      }
    }
  }
  if (!frames.length) return { ok: false, reason: 'ffmpeg produced no frames', frames: [] };
  return { ok: true, frames, durationSeconds: info.durationSeconds, outputDir: dir };
}

/**
 * Build a video (or an animated GIF) from a set of images.
 *
 * @returns {{ok: boolean, path: string, bytes: number, reason?: string}}
 */
function makeVideo(imagePaths = [], { fps = 2, output, format = 'mp4', duration = null } = {}) {
  const ffmpeg = ffmpegPath();
  if (!ffmpeg) return { ok: false, reason: 'ffmpeg is not installed — install ffmpeg to build a video' };
  if (!imagePaths.length) return { ok: false, reason: 'no images to build a video from' };
  const missing = imagePaths.filter((p) => !fs.existsSync(p));
  if (missing.length) return { ok: false, reason: `missing image: ${missing[0]}` };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qx-video-'));
  const extension = format === 'gif' ? 'gif' : 'mp4';
  const target = output ?? path.join(dir, `clip.${extension}`);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const listFile = path.join(dir, 'frames.txt');
  fs.writeFileSync(listFile, imagePaths.map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join('\n'), 'utf8');

  // The concat demuxer has no frame rate of its own, so one has to be
  // declared on the input or the filter graph sees no frames at all.
  const args = ['-y', '-r', String(fps), '-f', 'concat', '-safe', '0', '-i', listFile];
  if (format === 'gif') {
    // A palette pass keeps the GIF's colours sane.
    args.push('-vf', `fps=${fps},scale=640:-1:flags=lanczos,split[a][b];[a]palettegen[p];[b][p]paletteuse`);
  } else {
    args.push('-r', String(fps), '-pix_fmt', 'yuv420p', '-vcodec', 'libx264');
  }
  args.push(target);
  const result = spawnSync(ffmpeg, args, { encoding: 'utf8', timeout: 300_000 });
  if (result.status !== 0 || !fs.existsSync(target)) {
    return { ok: false, reason: `ffmpeg exited ${result.status}: ${String(result.stderr || '').split('\n').slice(-3).join(' ')}` };
  }
  return { ok: true, path: target, bytes: fs.statSync(target).size, fps, format: extension };
}

/** Cut the audio track out of a video so it can be transcribed. */
function extractAudio(videoPath, output = null) {
  const ffmpeg = ffmpegPath();
  if (!ffmpeg) return { ok: false, reason: 'ffmpeg is not installed' };
  const target = output ?? path.join(os.tmpdir(), `qx-audio-${Date.now()}.m4a`);
  const result = spawnSync(ffmpeg, ['-y', '-i', videoPath, '-vn', '-ac', '1', '-ar', '16000', target], {
    encoding: 'utf8', timeout: 300_000,
  });
  if (result.status !== 0 || !fs.existsSync(target)) {
    return { ok: false, reason: `ffmpeg exited ${result.status}` };
  }
  return { ok: true, path: target, bytes: fs.statSync(target).size };
}

/* ------------------------------------------------------------------ speech */

/**
 * The tone / pace / style system for generated speech (MUL-10…12).
 *
 * The system voice is the local one, so this is a real mapping rather than a
 * label: a "professional" tone picks a measured voice and a slower rate, a
 * "conversational" style rewrites the punctuation the way a person would
 * say it, and a "promotional" style adds the emphasis a presenter would.
 */
const TONES = {
  professional: { label: 'Professional', rate: 165, pitch: 0 },
  friendly: { label: 'Friendly', rate: 180, pitch: 8 },
  casual: { label: 'Casual', rate: 195, pitch: 6 },
  energetic: { label: 'Energetic', rate: 215, pitch: 12 },
  calm: { label: 'Calm', rate: 150, pitch: -6 },
};
const PACES = {
  fast: { label: 'Fast', factor: 1.25 },
  moderate: { label: 'Moderate', factor: 1.0 },
  slow: { label: 'Slow', factor: 0.78 },
};
const STYLES = {
  conversational: { label: 'Conversational', rewrite: 'conversational' },
  formal: { label: 'Formal', rewrite: 'formal' },
  educational: { label: 'Educational', rewrite: 'educational' },
  promotional: { label: 'Promotional', rewrite: 'promotional' },
};

/**
 * Capitalise the first letter of every sentence.
 *
 * The rewrites below swap contractions for their long forms, which turns
 * "Don't" into "do not" at the start of a sentence — a voice reading that
 * aloud sounds wrong, so the capitalisation is restored afterwards.
 */
function capitalizeSentences(text) {
  return String(text ?? '').replace(/(^|[.!?]\s+)([a-z])/g, (_match, prefix, letter) => prefix + letter.toUpperCase());
}

/** Rewrite the text the way the chosen style would say it. */
function shapeForStyle(text, style) {
  const source = String(text ?? '');
  switch (style) {
    case 'conversational':
      // Spoken contractions and shorter sentences.
      return capitalizeSentences(source
        .replace(/\bdo not\b/gi, "don't")
        .replace(/\bdoes not\b/gi, "doesn't")
        .replace(/\bis not\b/gi, "isn't")
        .replace(/\bit is\b/gi, "it's")
        .replace(/\bwe are\b/gi, "we're")
        .replace(/\byou are\b/gi, "you're")
        .replace(/\bthat is\b/gi, "that's")
        .replace(/;+/g, '.')
        .replace(/\s{2,}/g, ' '));
    case 'formal':
      return capitalizeSentences(source
        .replace(/\bdon't\b/gi, 'do not')
        .replace(/\bdoesn't\b/gi, 'does not')
        .replace(/\bisn't\b/gi, 'is not')
        .replace(/\bit's\b/gi, 'it is')
        .replace(/\bwe're\b/gi, 'we are')
        .replace(/\byou're\b/gi, 'you are')
        .replace(/\bthat's\b/gi, 'that is')
        .replace(/\bcan't\b/gi, 'cannot')
        .replace(/\bwon't\b/gi, 'will not')
        .replace(/\bhey\b/gi, 'Hello')
        .replace(/\bok\b/gi, 'all right'));
    case 'educational':
      // Short sentences, with a pause marker where a list item starts.
      return capitalizeSentences(source
        .replace(/([.!?])\s+/g, '$1. ')
        .replace(/\b(\d+)\.\s/g, '$1. ')
        .replace(/(^|\. )([A-Z][^.!?]{20,120})(?=[.!?]|$)/g, '$1$2. '));
    case 'promotional':
      return capitalizeSentences(source
        .replace(/([.!?])\s+/g, '$1 ')
        .replace(/\b(important|amazing|incredible|powerful|effortless|best)\b/gi, (m) => m.toUpperCase())
        .replace(/\s{2,}/g, ' '));
    default:
      return source;
  }
}

/**
 * Speak some text with a tone, a pace and a style.
 *
 * The synthesis itself is the system voice (`say`), so it is real speech on
 * this Mac with no cloud round trip.
 */
function speak(text, { tone = 'professional', pace = 'moderate', style = 'conversational', voice = null, output = null } = {}) {
  const toneSpec = TONES[tone] ?? TONES.professional;
  const paceSpec = PACES[pace] ?? PACES.moderate;
  const styleSpec = STYLES[style] ?? STYLES.conversational;
  const shaped = shapeForStyle(text, styleSpec.rewrite);
  const rate = Math.round(toneSpec.rate * paceSpec.factor);
  const target = output ?? path.join(os.tmpdir(), `qx-speech-${Date.now()}.aiff`);
  const args = ['-o', target, '-r', String(rate)];
  if (voice) args.push('-v', String(voice));
  args.push('--', shaped);
  const result = spawnSync('/usr/bin/say', args, { encoding: 'utf8', timeout: 120_000 });
  if (result.status !== 0 || !fs.existsSync(target)) {
    return { ok: false, reason: `the system voice failed (exit ${result.status})`, text: shaped };
  }
  return {
    ok: true,
    path: target,
    bytes: fs.statSync(target).size,
    rate,
    tone: toneSpec.label,
    pace: paceSpec.label,
    style: styleSpec.label,
    text: shaped,
  };
}

/** The system voices, for the voice picker. */
function listVoices() {
  const result = spawnSync('/usr/bin/say', ['-v', '?'], { encoding: 'utf8', timeout: 30_000 });
  if (result.status !== 0) return [];
  return String(result.stdout || '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [name, locale] = line.split('#');
      return { name: (name ?? '').trim(), locale: (locale ?? '').trim() };
    })
    .filter((voice) => voice.name);
}

/* ---------------------------------------------------------------- exports */

module.exports = {
  multimediaService: {
    ocrImage,
    ocrBatch,
    analyzeImage,
    compareImages,
    probeVideo,
    extractFrames,
    makeVideo,
    extractAudio,
    speak,
    listVoices,
    shapeForStyle,
    TONES,
    PACES,
    STYLES,
    // capability probes
    visionAvailable,
    visionHelperPath,
    ffmpegAvailable: () => Boolean(ffmpegPath()),
  },
};
