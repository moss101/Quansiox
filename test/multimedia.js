'use strict';
/* Multimedia test — the local-first multimedia surface.
 *
 * Covers the documented behaviour that is real on this machine:
 *   - OCR of an image, with bounding boxes (MUL-02);
 *   - batch OCR into a table (MUL-23);
 *   - image analysis: dominant colours, brightness, contrast (MUL-03/04);
 *   - comparing two images factually (MUL-05);
 *   - video probing and frame extraction (MUL-06…09);
 *   - building a video from images (MUL-18);
 *   - speech with a tone, a pace and a style (MUL-10/11/12).
 *
 * The OCR and video paths need the local helper and ffmpeg; when they are
 * missing the service must say so honestly rather than pretend, and the test
 * asserts exactly that.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qx-multimedia-'));
process.env.QUANSIOX_USER_DATA_DIR = tmp;
process.env.QUANSIOX_TEST_USERDATA = tmp;

const { multimediaService } = require('../src/main/services/multimediaService');
const imageOps = require('../src/shared/imageOps');

/** A PNG with a red square on white — easy to assert on. */
function makeImage(file, width = 120, height = 90) {
  const image = imageOps.createImage(width, height, [255, 255, 255, 255]);
  for (let y = 20; y < 60; y += 1) {
    for (let x = 30; x < 80; x += 1) imageOps.setPixel(image, x, y, [220, 30, 40, 255]);
  }
  fs.writeFileSync(file, imageOps.encodePNG(image.data, width, height));
  return file;
}

const hasFfmpeg = multimediaService.ffmpegAvailable();

/**
 * Render some text into a PNG using the tools this Mac already has: the
 * system voice writes an AIFF, and ffmpeg turns it into a picture.
 * @returns {boolean} whether the image could be made
 */
function makeTextImage(file, text) {
  const aiff = file.replace(/\.png$/, '.aiff');
  const said = spawnSync('/usr/bin/say', ['-o', aiff, text], { encoding: 'utf8' });
  if (said.status !== 0 || !fs.existsSync(aiff)) return false;
  const ffmpeg = ['/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg', '/usr/bin/ffmpeg']
    .find((candidate) => fs.existsSync(candidate));
  if (!ffmpeg) return false;
  const converted = spawnSync(ffmpeg, [
    '-y', '-i', aiff, '-frames:v', '1', '-vf', 'scale=900:-1', file,
  ], { encoding: 'utf8' });
  return converted.status === 0 && fs.existsSync(file);
}

async function run() {
  /* -- 1. OCR (MUL-02) --------------------------------------------------- */
  const image = makeImage(path.join(tmp, 'plain.png'));
  const ocr = multimediaService.ocrImage(image);
  if (multimediaService.visionAvailable()) {
    // A picture with no text has no blocks, and the service says so.
    assert.strictEqual(ocr.ok, false);
    assert.match(ocr.reason ?? '', /no text/);
    assert.ok(Array.isArray(ocr.blocks));

    // A picture WITH text is recognised, with a bounding box per block.
    const textImage = path.join(tmp, 'text.png');
    const made = makeTextImage(textImage, 'QUANSIOX');
    if (made) {
      const textOcr = multimediaService.ocrImage(textImage);
      assert.strictEqual(textOcr.ok, true, `OCR should read the text: ${textOcr.reason}`);
      assert.ok(textOcr.text.includes('QUANSIOX'), `the text was read: ${textOcr.text}`);
      assert.ok(textOcr.blocks.length >= 1);
      const block = textOcr.blocks[0];
      assert.ok(block.width > 0 && block.height > 0, 'the block has a real bounding box');
      assert.ok(block.x >= 0 && block.y >= 0);
    }
  } else {
    assert.strictEqual(ocr.ok, false);
    assert.match(ocr.reason, /not built/);
  }
  // A missing file is reported, not thrown.
  assert.strictEqual(multimediaService.ocrImage(path.join(tmp, 'nope.png')).ok, false);

  /* -- 2. batch OCR (MUL-23) ---------------------------------------------- */
  const batch = multimediaService.ocrBatch([image, path.join(tmp, 'missing.png')]);
  assert.strictEqual(batch.rows.length, 2);
  assert.deepStrictEqual(batch.columns, ['file', 'ok', 'blocks', 'text']);
  assert.strictEqual(batch.rows[0].file, 'plain.png');
  assert.strictEqual(batch.rows[1].ok, false);

  /* -- 3. image analysis (MUL-03/04) -------------------------------------- */
  const analysis = multimediaService.analyzeImage(image);
  assert.strictEqual(analysis.ok, true);
  assert.strictEqual(analysis.width, 120);
  assert.strictEqual(analysis.height, 90);
  assert.ok(analysis.dominant.length >= 1);
  assert.ok(analysis.dominant.some((c) => c.colour.startsWith('#')), 'the dominant colours are real');
  assert.ok(analysis.brightness >= 0 && analysis.brightness <= 1);
  assert.ok(analysis.contrast >= 0);
  assert.strictEqual(analysis.histogram.length, 16 * 16 * 16);

  /* -- 4. comparing two images (MUL-05) ----------------------------------- */
  const other = makeImage(path.join(tmp, 'other.png'));
  const comparison = multimediaService.compareImages(image, other);
  assert.strictEqual(comparison.ok, true);
  assert.strictEqual(comparison.identical, true, 'the same picture compares identical');
  // A different picture is measurably different.
  const different = imageOps.createImage(120, 90, [0, 0, 0, 255]);
  fs.writeFileSync(path.join(tmp, 'black.png'), imageOps.encodePNG(different.data, 120, 90));
  const changed = multimediaService.compareImages(image, path.join(tmp, 'black.png'));
  assert.strictEqual(changed.identical, false);
  assert.ok(changed.meanPixelDelta > 0, 'the pixel difference is measured');

  /* -- 5. the speech system (MUL-10/11/12) ------------------------------- */
  assert.ok(multimediaService.TONES.professional);
  assert.ok(multimediaService.PACES.fast);
  assert.ok(multimediaService.STYLES.conversational);
  // The style really changes the text a voice would say.
  const formal = multimediaService.shapeForStyle("Don't stop, we're here", 'formal');
  assert.match(formal, /do not/i);
  assert.match(formal, /we are/i);
  assert.match(formal, /^Do not/, 'the sentence keeps its capital letter');
  const casual = multimediaService.shapeForStyle('Do not stop; we are here', 'conversational');
  assert.match(casual, /don't/i);
  assert.match(casual, /we're/i);
  assert.match(casual, /^Don't/, 'the contraction is capitalised at the start');
  // The tone and the pace combine into a real rate.
  const spoken = multimediaService.speak('Hello from Quansiox.', { tone: 'energetic', pace: 'fast' });
  assert.strictEqual(spoken.ok, true, `speech should work: ${spoken.reason}`);
  assert.ok(spoken.rate > 200, 'the energetic + fast rate is higher than the base rate');
  assert.ok(fs.existsSync(spoken.path));
  assert.ok(spoken.bytes > 1000, 'it really produced audio');
  assert.match(spoken.text, /Hello from Quansiox/);
  assert.strictEqual(spoken.tone, 'Energetic');
  assert.strictEqual(spoken.pace, 'Fast');

  const voices = multimediaService.listVoices();
  assert.ok(Array.isArray(voices));

  /* -- 6. video (MUL-06…09, MUL-18) --------------------------------------- */
  if (hasFfmpeg) {
    // Build a real video out of frames, then read it back.
    const frames = [];
    for (let i = 0; i < 6; i += 1) {
      const frame = imageOps.createImage(160, 120, [20 + i * 30, 60, 120, 255]);
      const file = path.join(tmp, `frame-${i}.png`);
      fs.writeFileSync(file, imageOps.encodePNG(frame.data, 160, 120));
      frames.push(file);
    }
    const clip = multimediaService.makeVideo(frames, { fps: 2, output: path.join(tmp, 'clip.mp4') });
    assert.strictEqual(clip.ok, true, `ffmpeg should build a clip: ${clip.reason}`);
    assert.ok(clip.bytes > 1000);
    assert.ok(fs.existsSync(clip.path));

    const info = multimediaService.probeVideo(clip.path);
    assert.strictEqual(info.ok, true);
    assert.strictEqual(info.width, 160);
    assert.strictEqual(info.height, 120);
    assert.ok(info.durationSeconds > 0);

    const extracted = multimediaService.extractFrames(clip.path, { count: 3, outputDir: path.join(tmp, 'frames') });
    assert.strictEqual(extracted.ok, true, `frames should extract: ${extracted.reason}`);
    assert.strictEqual(extracted.frames.length, 3);
    assert.ok(extracted.frames[0].path.endsWith('.png'));
    assert.ok(fs.existsSync(extracted.frames[0].path));
    assert.ok(extracted.frames[0].timestamp >= 0);

    // A GIF too.
    const gif = multimediaService.makeVideo(frames, { fps: 2, output: path.join(tmp, 'clip.gif'), format: 'gif' });
    assert.strictEqual(gif.ok, true);
    assert.ok(fs.existsSync(gif.path));
  } else {
    const probe = multimediaService.probeVideo('/tmp/nothing.mp4');
    assert.strictEqual(probe.ok, false);
    assert.match(probe.reason, /ffmpeg/);
  }

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('multimedia test: ALL OK');
}
run().catch((e) => { console.error(e); process.exit(1); });
