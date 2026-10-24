'use strict';
/**
 * Design View — the local-first implementation of Manus' design surface.
 *
 * The documented surface is a canvas on top of an image where you:
 *
 *   - **mark** a region (DSN-02) and attach an instruction to it (DSN-03);
 *   - **batch** several marked regions into one submission (DSN-04);
 *   - add elements from a **reference image** (DSN-05);
 *   - **edit the text** in the image without disturbing the rest (DSN-06);
 *   - keep the overall composition, lighting and style (DSN-11).
 *
 * This module owns the parts that are real on the user's own machine:
 *
 *   - a **design session** over one image, with a **version history** (the
 *     product shows a "2 / 2" version card and an Original / Modified /
 *     Diff comparison);
 *   - **marked regions** with instructions, applied as a batch;
 *   - **real pixel edits**: upscale, background removal, crop, rotate, and
 *     per-region adjustments (brightness, contrast, saturation, hue, tint,
 *     soften);
 *   - **text extraction** through the local OCR helper, and a text edit
 *     that patches the region and re-renders the new text;
 *   - a **reference image** that can be composited onto the canvas.
 *
 * What it does NOT do is pretend to be an image model. A region instruction
 * such as "change this to muted sage green" is applied as a real,
 * deterministic adjustment (a hue/saturation/tint change toward that
 * colour), and the result is labelled as a local adjustment — not passed
 * off as generative inpainting.
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const imageOps = require('../../shared/imageOps');
const { multimediaService } = require('./multimediaService');

/* ------------------------------------------------------------------ store */

function userDataDir() {
  return require('./userData').userDataDir();
}
function designsDir() { return path.join(userDataDir(), 'designs'); }
function designFile(id) {
  if (!/^dsn_[A-Za-z0-9_-]{1,64}$/.test(String(id || ''))) throw new Error('invalid design id');
  return path.join(designsDir(), `${id}.json`);
}
function newId() { return `dsn_${crypto.randomBytes(9).toString('base64url')}`; }

function load(id) {
  try {
    return JSON.parse(fs.readFileSync(designFile(id), 'utf8'));
  } catch {
    return null;
  }
}
function save(design) {
  fs.mkdirSync(designsDir(), { recursive: true });
  fs.writeFileSync(designFile(design.id), JSON.stringify(design, null, 2), { mode: 0o600 });
  return design;
}

function reduced(design) {
  if (!design) return null;
  return {
    id: design.id,
    title: design.title,
    sessionId: design.sessionId ?? null,
    sourcePath: design.sourcePath,
    sourceWidth: design.sourceWidth,
    sourceHeight: design.sourceHeight,
    versions: (design.versions ?? []).map((version) => ({
      id: version.id,
      label: version.label,
      ops: version.ops ?? [],
      path: version.path,
      createdAt: version.createdAt,
      preview: version.preview ?? null,
    })),
    activeVersionId: design.activeVersionId,
    marks: design.marks ?? [],
    references: (design.references ?? []).map((r) => ({ id: r.id, path: r.path, name: path.basename(r.path) })),
    textElements: design.textElements ?? [],
    createdAt: design.createdAt,
    updatedAt: design.updatedAt,
  };
}

/* ------------------------------------------------------------------ model */

/**
 * Open a design session over an image.
 *
 * The original is copied into the design store, so the session keeps working
 * even if the source file moves.
 */
function create({ sourcePath, title, sessionId } = {}) {
  if (!sourcePath || !fs.existsSync(sourcePath)) throw new Error(`no such image: ${sourcePath}`);
  const id = newId();
  const dir = path.join(designsDir(), id);
  fs.mkdirSync(path.join(dir, 'versions'), { recursive: true });
  const originalName = `original${path.extname(sourcePath) || '.png'}`;
  const originalPath = path.join(dir, originalName);
  fs.copyFileSync(sourcePath, originalPath);

  let width = 0;
  let height = 0;
  try {
    const decoded = imageOps.decodePNG(fs.readFileSync(originalPath));
    width = decoded.width;
    height = decoded.height;
  } catch { /* a non-PNG original: the dimensions are unknown until an edit */ }

  const now = Date.now();
  const design = {
    id,
    title: String(title ?? path.basename(sourcePath)).slice(0, 160),
    sessionId: sessionId ?? null,
    sourcePath: originalPath,
    sourceWidth: width,
    sourceHeight: height,
    versions: [{
      id: 'v1',
      label: 'Original',
      ops: [],
      path: originalPath,
      createdAt: now,
    }],
    activeVersionId: 'v1',
    marks: [],
    references: [],
    textElements: [],
    createdAt: now,
    updatedAt: now,
  };
  save(design);
  return reduced(design);
}

function get(id) {
  return reduced(load(id));
}

function list() {
  try {
    return fs.readdirSync(designsDir())
      .filter((f) => f.endsWith('.json'))
      .map((f) => reduced(load(f.slice(0, -5))))
      .filter(Boolean)
      .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
  } catch {
    return [];
  }
}

function remove(id) {
  const design = load(id);
  if (!design) return { removed: false };
  try { fs.rmSync(path.join(designsDir(), id), { recursive: true, force: true }); } catch { /* best effort */ }
  try { fs.rmSync(designFile(id), { force: true }); } catch { /* best effort */ }
  return { removed: true, id };
}

/* ------------------------------------------------------------------ marks */

/**
 * Mark a region with an instruction (DSN-02/03).
 *
 * @param {string} id
 * @param {object} mark { x, y, width, height, instruction }
 */
function addMark(id, mark = {}) {
  const design = load(id);
  if (!design) throw new Error('design not found');
  const region = normalizeRegion(mark, design);
  const entry = {
    id: `mark_${crypto.randomBytes(6).toString('base64url')}`,
    ...region,
    instruction: String(mark.instruction ?? '').slice(0, 400),
    createdAt: Date.now(),
  };
  design.marks.push(entry);
  design.updatedAt = Date.now();
  save(design);
  return entry;
}

/** Mark several regions at once (DSN-04). */
function addMarks(id, marks = []) {
  return marks.map((mark) => addMark(id, mark));
}

function clearMarks(id) {
  const design = load(id);
  if (!design) throw new Error('design not found');
  design.marks = [];
  design.updatedAt = Date.now();
  save(design);
  return reduced(design);
}

function normalizeRegion(input, design) {
  const width = Math.max(1, Math.round(Number(input.width) || 0));
  const height = Math.max(1, Math.round(Number(input.height) || 0));
  const x = Math.max(0, Math.round(Number(input.x) || 0));
  const y = Math.max(0, Math.round(Number(input.y) || 0));
  const maxWidth = (design.sourceWidth || width + x) || width + x;
  const maxHeight = (design.sourceHeight || height + y) || height + y;
  return {
    x: Math.min(x, Math.max(0, maxWidth - 1)),
    y: Math.min(y, Math.max(0, maxHeight - 1)),
    width: Math.min(width, Math.max(1, maxWidth - x)),
    height: Math.min(height, Math.max(1, maxHeight - y)),
  };
}

/* ------------------------------------------------------------- text edits */

/**
 * Extract the text elements in the image (DSN-06) through the local OCR
 * helper.
 */
function extractTextElements(id) {
  const design = load(id);
  if (!design) throw new Error('design not found');
  const result = multimediaService.ocrImage(design.sourcePath);
  if (!result.ok) {
    design.textElements = [];
    design.updatedAt = Date.now();
    save(design);
    return { ok: false, reason: result.reason, elements: [] };
  }
  design.textElements = (result.blocks ?? []).map((block) => ({
    text: block.text,
    x: Math.round(block.x),
    y: Math.round(block.y),
    width: Math.round(block.width),
    height: Math.round(block.height),
    confidence: block.confidence,
  }));
  design.sourceWidth = result.width || design.sourceWidth;
  design.sourceHeight = result.height || design.sourceHeight;
  design.updatedAt = Date.now();
  save(design);
  return { ok: true, elements: design.textElements };
}

/* ------------------------------------------------------------------ edits */

/**
 * The edit operations the local engine understands. Each is a real,
 * deterministic change to the pixels.
 */
const OPERATIONS = {
  upscale: { label: 'Upscale', params: ['factor'] },
  'remove-background': { label: 'Remove background', params: ['tolerance'] },
  crop: { label: 'Crop', params: ['x', 'y', 'width', 'height'] },
  rotate: { label: 'Rotate', params: ['degrees'] },
  adjust: { label: 'Adjust', params: ['brightness', 'contrast', 'saturation', 'hue', 'tint', 'tintAmount', 'blur'] },
  'region-adjust': { label: 'Region adjust', params: ['region', 'brightness', 'contrast', 'saturation', 'hue', 'tint', 'tintAmount', 'blur'] },
  'edit-text': { label: 'Edit text', params: ['region', 'text', 'colour', 'fontSize'] },
  'composite-reference': { label: 'Add reference', params: ['referenceId', 'x', 'y', 'width', 'height', 'opacity'] },
};

/**
 * Apply a batch of edits, producing a new version.
 *
 * @param {string} id
 * @param {Array} ops  the operations to apply, in order
 * @param {object} options { label, baseVersionId }
 */
function applyOps(id, ops = [], { label, baseVersionId } = {}) {
  const design = load(id);
  if (!design) throw new Error('design not found');
  if (!Array.isArray(ops) || !ops.length) throw new Error('no operations to apply');

  const base = design.versions.find((v) => v.id === (baseVersionId ?? design.activeVersionId))
    ?? design.versions[design.versions.length - 1];
  let image = decodeImage(base.path);
  const applied = [];

  for (const op of ops) {
    const type = String(op?.type ?? '');
    if (!OPERATIONS[type]) throw new Error(`unknown operation: ${type}`);
    image = applyOperation(image, op, design);
    applied.push({ ...op, type });
  }

  const dir = path.join(designsDir(), design.id, 'versions');
  fs.mkdirSync(dir, { recursive: true });
  const versionId = `v${design.versions.length + 1}`;
  const file = path.join(dir, `${versionId}.png`);
  fs.writeFileSync(file, imageOps.encodePNG(image.data, image.width, image.height));

  const version = {
    id: versionId,
    label: String(label ?? `Version ${design.versions.length + 1}`).slice(0, 120),
    ops: applied,
    path: file,
    createdAt: Date.now(),
  };
  design.versions.push(version);
  design.activeVersionId = versionId;
  design.sourceWidth = image.width;
  design.sourceHeight = image.height;
  design.updatedAt = Date.now();
  save(design);
  return reduced(design);
}

/** Decode an image file into an RGBA image, converting when necessary. */
function decodeImage(filePath) {
  const buffer = fs.readFileSync(filePath);
  try {
    return imageOps.decodePNG(buffer);
  } catch (error) {
    throw new Error(`cannot decode ${path.basename(filePath)} as PNG (${error.message})`);
  }
}

/** Apply one operation to an image. */
function applyOperation(image, op, design) {
  switch (op.type) {
    case 'upscale': {
      const factor = Math.min(4, Math.max(1, Number(op.factor) || 2));
      return imageOps.upscale(image, factor);
    }
    case 'remove-background': {
      const result = imageOps.removeBackground(image, { tolerance: Number(op.tolerance) || 32 });
      return result.image;
    }
    case 'crop': {
      return imageOps.crop(image, {
        x: Number(op.x) || 0,
        y: Number(op.y) || 0,
        width: Number(op.width) || image.width,
        height: Number(op.height) || image.height,
      });
    }
    case 'rotate': {
      return imageOps.rotate(image, Number(op.degrees) || 90);
    }
    case 'adjust': {
      return imageOps.adjust(image, null, {
        brightness: Number(op.brightness) || 0,
        contrast: Number(op.contrast) || 0,
        saturation: op.saturation === undefined ? 1 : Number(op.saturation),
        hue: Number(op.hue) || 0,
        tint: op.tint ?? null,
        tintAmount: Number(op.tintAmount) || 0,
        blur: Number(op.blur) || 0,
      });
    }
    case 'region-adjust': {
      const region = op.region ?? {};
      return imageOps.adjust(image, region, {
        brightness: Number(op.brightness) || 0,
        contrast: Number(op.contrast) || 0,
        saturation: op.saturation === undefined ? 1 : Number(op.saturation),
        hue: Number(op.hue) || 0,
        tint: op.tint ?? null,
        tintAmount: Number(op.tintAmount) || 0,
        blur: Number(op.blur) || 0,
      });
    }
    case 'edit-text': {
      return editText(image, op);
    }
    case 'composite-reference': {
      const reference = (design.references ?? []).find((r) => r.id === op.referenceId);
      if (!reference) throw new Error(`unknown reference image: ${op.referenceId}`);
      const overlay = decodeImage(reference.path);
      const targetWidth = Math.round(Number(op.width) || overlay.width);
      const targetHeight = Math.round(Number(op.height) || overlay.height);
      const scaled = imageOps.resize(overlay, targetWidth, targetHeight);
      const opacity = op.opacity === undefined ? 1 : Math.max(0, Math.min(1, Number(op.opacity)));
      if (opacity < 1) {
        for (let i = 3; i < scaled.data.length; i += 4) scaled.data[i] = Math.round(scaled.data[i] * opacity);
      }
      return imageOps.composite(image, scaled, Math.round(Number(op.x) || 0), Math.round(Number(op.y) || 0));
    }
    default:
      throw new Error(`unknown operation: ${op.type}`);
  }
}

/**
 * Replace the text in a region (DSN-06).
 *
 * The old text is covered with the region's own average colour (so the rest
 * of the image is untouched), and the new text is drawn on top with a small
 * built-in bitmap font — no font file and no native text stack, so the
 * result is identical everywhere.
 */
function editText(image, op) {
  const region = {
    x: Math.round(Number(op.region?.x) || 0),
    y: Math.round(Number(op.region?.y) || 0),
    width: Math.round(Number(op.region?.width) || 0),
    height: Math.round(Number(op.region?.height) || 0),
  };
  if (region.width <= 0 || region.height <= 0) throw new Error('edit-text needs a region');
  const fill = imageOps.averageColour(image, region);
  imageOps.fillRect(image, region, fill);
  const colour = op.colour ? imageOps.hexToRgb(op.colour) : [17, 17, 17, 255];
  const fontSize = Math.max(6, Math.min(200, Math.round(Number(op.fontSize) || Math.max(8, region.height * 0.7))));
  drawText(image, String(op.text ?? ''), region.x, region.y, region.width, region.height, colour, fontSize);
  return image;
}

/* ------------------------------------------------------------ bitmap font */

/**
 * A 5×7 bitmap font for the letters that matter (upper case, lower case,
 * digits and common punctuation). Each glyph is five columns of seven bits.
 */
const GLYPHS = {
  A: [0x7e, 0x11, 0x11, 0x11, 0x7e], B: [0x7f, 0x49, 0x49, 0x49, 0x36], C: [0x3e, 0x41, 0x41, 0x41, 0x22],
  D: [0x7f, 0x41, 0x41, 0x22, 0x1c], E: [0x7f, 0x49, 0x49, 0x49, 0x41], F: [0x7f, 0x09, 0x09, 0x09, 0x01],
  G: [0x3e, 0x41, 0x49, 0x49, 0x7a], H: [0x7f, 0x08, 0x08, 0x08, 0x7f], I: [0x00, 0x41, 0x7f, 0x41, 0x00],
  J: [0x20, 0x40, 0x41, 0x3f, 0x01], K: [0x7f, 0x08, 0x14, 0x22, 0x41], L: [0x7f, 0x40, 0x40, 0x40, 0x40],
  M: [0x7f, 0x02, 0x0c, 0x02, 0x7f], N: [0x7f, 0x04, 0x08, 0x10, 0x7f], O: [0x3e, 0x41, 0x41, 0x41, 0x3e],
  P: [0x7f, 0x09, 0x09, 0x09, 0x06], Q: [0x3e, 0x41, 0x51, 0x21, 0x5e], R: [0x7f, 0x09, 0x19, 0x29, 0x46],
  S: [0x46, 0x49, 0x49, 0x49, 0x31], T: [0x01, 0x01, 0x7f, 0x01, 0x01], U: [0x3f, 0x40, 0x40, 0x40, 0x3f],
  V: [0x1f, 0x20, 0x40, 0x20, 0x1f], W: [0x3f, 0x40, 0x38, 0x40, 0x3f], X: [0x63, 0x14, 0x08, 0x14, 0x63],
  Y: [0x07, 0x08, 0x70, 0x08, 0x07], Z: [0x61, 0x51, 0x49, 0x45, 0x43],
  a: [0x20, 0x54, 0x54, 0x54, 0x78], b: [0x7f, 0x48, 0x44, 0x44, 0x38], c: [0x38, 0x44, 0x44, 0x44, 0x20],
  d: [0x38, 0x44, 0x44, 0x48, 0x7f], e: [0x38, 0x54, 0x54, 0x54, 0x18], f: [0x08, 0x7e, 0x09, 0x01, 0x02],
  g: [0x0c, 0x52, 0x52, 0x52, 0x3e], h: [0x7f, 0x08, 0x04, 0x04, 0x78], i: [0x00, 0x44, 0x7d, 0x40, 0x00],
  j: [0x20, 0x40, 0x44, 0x3d, 0x00], k: [0x7f, 0x10, 0x28, 0x44, 0x00], l: [0x00, 0x41, 0x7f, 0x40, 0x00],
  m: [0x7c, 0x04, 0x18, 0x04, 0x78], n: [0x7c, 0x08, 0x04, 0x04, 0x78], o: [0x38, 0x44, 0x44, 0x44, 0x38],
  p: [0x7c, 0x14, 0x14, 0x14, 0x08], q: [0x08, 0x14, 0x14, 0x18, 0x7c], r: [0x7c, 0x08, 0x04, 0x04, 0x08],
  s: [0x48, 0x54, 0x54, 0x54, 0x20], t: [0x04, 0x3f, 0x44, 0x40, 0x20], u: [0x3c, 0x40, 0x40, 0x20, 0x7c],
  v: [0x1c, 0x20, 0x40, 0x20, 0x1c], w: [0x3c, 0x40, 0x30, 0x40, 0x3c], x: [0x44, 0x28, 0x10, 0x28, 0x44],
  y: [0x0c, 0x50, 0x50, 0x50, 0x3c], z: [0x44, 0x64, 0x54, 0x4c, 0x44],
  0: [0x3e, 0x51, 0x49, 0x45, 0x3e], 1: [0x00, 0x42, 0x7f, 0x40, 0x00], 2: [0x42, 0x61, 0x51, 0x49, 0x46],
  3: [0x21, 0x41, 0x45, 0x4b, 0x31], 4: [0x18, 0x14, 0x12, 0x7f, 0x10], 5: [0x27, 0x45, 0x45, 0x45, 0x39],
  6: [0x3c, 0x4a, 0x49, 0x49, 0x30], 7: [0x01, 0x71, 0x09, 0x05, 0x03], 8: [0x36, 0x49, 0x49, 0x49, 0x36],
  9: [0x06, 0x49, 0x49, 0x29, 0x1e],
  ' ': [0x00, 0x00, 0x00, 0x00, 0x00], '.': [0x00, 0x60, 0x60, 0x00, 0x00], ',': [0x00, 0x80, 0x60, 0x00, 0x00],
  '!': [0x00, 0x00, 0x5f, 0x00, 0x00], '?': [0x02, 0x01, 0x51, 0x09, 0x06], ':': [0x00, 0x36, 0x36, 0x00, 0x00],
  '-': [0x08, 0x08, 0x08, 0x08, 0x08], '/': [0x20, 0x10, 0x08, 0x04, 0x02], "'": [0x00, 0x07, 0x00, 0x00, 0x00],
  '(': [0x00, 0x1c, 0x22, 0x41, 0x00], ')': [0x00, 0x41, 0x22, 0x1c, 0x00], '&': [0x36, 0x49, 0x55, 0x22, 0x50],
  '·': [0x00, 0x08, 0x08, 0x00, 0x00],
};

/**
 * Draw text with the bitmap font.
 *
 * @param {object} image
 * @param {string} text
 * @param {number} x  left edge
 * @param {number} y  top edge
 * @param {number} maxWidth
 * @param {number} maxHeight
 * @param {number[]} colour  [r, g, b, a]
 * @param {number} fontSize  the glyph height in pixels
 */
function drawText(image, text, x, y, maxWidth, maxHeight, colour, fontSize) {
  const glyphHeight = Math.max(5, Math.min(fontSize, maxHeight));
  const glyphWidth = Math.max(3, Math.round(glyphHeight * 0.6));
  const spacing = Math.max(1, Math.round(glyphWidth * 0.2));
  const characters = String(text ?? '').split('');
  const perCharacter = glyphWidth + spacing;
  const maxCharacters = Math.max(1, Math.floor((maxWidth + spacing) / perCharacter));
  const shown = characters.slice(0, maxCharacters);
  // Centre the text in the region.
  const totalWidth = shown.length * perCharacter - spacing;
  let cursorX = x + Math.max(0, Math.round((maxWidth - totalWidth) / 2));
  const cursorY = y + Math.max(0, Math.round((maxHeight - glyphHeight) / 2));

  for (const character of shown) {
    const glyph = GLYPHS[character] ?? GLYPHS[character.toUpperCase()] ?? GLYPHS['?'];
    for (let column = 0; column < 5; column += 1) {
      const bits = glyph[column];
      for (let row = 0; row < 7; row += 1) {
        if (!(bits & (1 << row))) continue;
        // Scale the 5×7 cell up to the requested glyph size.
        const cellWidth = Math.max(1, Math.round(glyphWidth / 5));
        const cellHeight = Math.max(1, Math.round(glyphHeight / 7));
        const px = cursorX + column * cellWidth;
        const py = cursorY + row * cellHeight;
        for (let dy = 0; dy < cellHeight; dy += 1) {
          for (let dx = 0; dx < cellWidth; dx += 1) {
            const targetX = px + dx;
            const targetY = py + dy;
            if (targetX < 0 || targetY < 0 || targetX >= image.width || targetY >= image.height) continue;
            imageOps.setPixel(image, targetX, targetY, colour);
          }
        }
      }
    }
    cursorX += perCharacter;
  }
  return image;
}

/* --------------------------------------------------------------- reference */

/** Attach a reference image (DSN-05). */
function addReference(id, referencePath) {
  const design = load(id);
  if (!design) throw new Error('design not found');
  if (!referencePath || !fs.existsSync(referencePath)) throw new Error(`no such image: ${referencePath}`);
  const dir = path.join(designsDir(), design.id, 'references');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `ref_${crypto.randomBytes(5).toString('base64url')}${path.extname(referencePath) || '.png'}`);
  fs.copyFileSync(referencePath, file);
  const entry = { id: `ref_${path.basename(file).slice(4, 12)}`, path: file };
  design.references.push(entry);
  design.updatedAt = Date.now();
  save(design);
  return entry;
}

/* ------------------------------------------------------------- comparison */

/**
 * Compare the original with a version (the product's Diff / Original /
 * Modified viewer).
 */
function compare(id, versionId) {
  const design = load(id);
  if (!design) throw new Error('design not found');
  const version = design.versions.find((v) => v.id === versionId) ?? design.versions[design.versions.length - 1];
  const original = design.versions[0];
  try {
    const a = decodeImage(original.path);
    const b = decodeImage(version.path);
    const diff = imageOps.difference(a, b);
    return {
      ok: true,
      versionId: version.id,
      originalPath: original.path,
      modifiedPath: version.path,
      meanDelta: diff.meanDelta,
      identical: diff.meanDelta === 0,
      width: b.width,
      height: b.height,
    };
  } catch (error) {
    return { ok: false, reason: error.message };
  }
}

module.exports = {
  designService: {
    OPERATIONS,
    create,
    get,
    list,
    remove,
    addMark,
    addMarks,
    clearMarks,
    extractTextElements,
    applyOps,
    addReference,
    compare,
    // exported for tests
    _load: load,
    _reduced: reduced,
    _drawText: drawText,
  },
};
