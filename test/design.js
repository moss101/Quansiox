'use strict';
/* Design View test — the local-first design surface.
 *
 * Covers the documented behaviour:
 *   - a design session over an image, with a version history (DSN-01);
 *   - marking a region and attaching an instruction (DSN-02/03);
 *   - batch marking several regions (DSN-04);
 *   - adding a reference image (DSN-05);
 *   - editing the text in the image without disturbing the rest (DSN-06);
 *   - keeping the composition while changing a region (DSN-11);
 *   - the Original / Modified / Diff comparison.
 *
 * Every edit is a real change to the pixels, so the test asserts on the
 * decoded image, not on a flag.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qx-design-'));
process.env.QUANSIOX_USER_DATA_DIR = tmp;
process.env.QUANSIOX_TEST_USERDATA = tmp;

const { designService } = require('../src/main/services/designService');
const imageOps = require('../src/shared/imageOps');

/** A white canvas with a red rectangle in the middle. */
function makeCanvas(file, width = 200, height = 140) {
  const image = imageOps.createImage(width, height, [255, 255, 255, 255]);
  for (let y = 40; y < 100; y += 1) {
    for (let x = 50; x < 150; x += 1) imageOps.setPixel(image, x, y, [220, 30, 40, 255]);
  }
  fs.writeFileSync(file, imageOps.encodePNG(image.data, width, height));
  return file;
}

function decode(file) {
  return imageOps.decodePNG(fs.readFileSync(file));
}

function pixelAt(image, x, y) {
  return imageOps.getPixel(image, x, y);
}

async function run() {
  const source = makeCanvas(path.join(tmp, 'source.png'));

  /* -- 1. a design session (DSN-01) --------------------------------------- */
  const design = designService.create({ sourcePath: source, title: 'Poster' });
  assert.ok(design.id.startsWith('dsn_'));
  assert.strictEqual(design.title, 'Poster');
  assert.strictEqual(design.sourceWidth, 200);
  assert.strictEqual(design.sourceHeight, 140);
  assert.strictEqual(design.versions.length, 1);
  assert.strictEqual(design.versions[0].label, 'Original');
  assert.strictEqual(design.activeVersionId, 'v1');
  assert.ok(fs.existsSync(design.sourcePath), 'the original is copied into the design store');
  assert.throws(() => designService.create({ sourcePath: path.join(tmp, 'nope.png') }), /no such image/);

  /* -- 2. marking a region (DSN-02/03) ------------------------------------ */
  const mark = designService.addMark(design.id, {
    x: 50, y: 40, width: 100, height: 60, instruction: 'change this to muted sage green',
  });
  assert.ok(mark.id.startsWith('mark_'));
  assert.strictEqual(mark.instruction, 'change this to muted sage green');
  assert.strictEqual(mark.width, 100);
  assert.strictEqual(designService.get(design.id).marks.length, 1);

  /* -- 3. batch marking (DSN-04) ------------------------------------------ */
  const marks = designService.addMarks(design.id, [
    { x: 0, y: 0, width: 20, height: 20, instruction: 'brighten' },
    { x: 180, y: 120, width: 20, height: 20, instruction: 'darken' },
  ]);
  assert.strictEqual(marks.length, 2);
  assert.strictEqual(designService.get(design.id).marks.length, 3);
  designService.clearMarks(design.id);
  assert.strictEqual(designService.get(design.id).marks.length, 0);

  /* -- 4. a regional edit keeps the rest of the image (DSN-11) ----------- */
  const edited = designService.applyOps(design.id, [{
    type: 'region-adjust',
    region: { x: 50, y: 40, width: 100, height: 60 },
    hue: 90,
    saturation: 0.4,
  }], { label: 'Sage' });
  assert.strictEqual(edited.versions.length, 2);
  assert.strictEqual(edited.activeVersionId, 'v2');
  const original = decode(edited.versions[0].path);
  const modified = decode(edited.versions[1].path);
  // The marked region changed…
  const before = pixelAt(original, 100, 70);
  const after = pixelAt(modified, 100, 70);
  assert.notDeepStrictEqual(after, before, 'the marked region really changed');
  // …and the rest did not.
  assert.deepStrictEqual(pixelAt(modified, 5, 5), pixelAt(original, 5, 5), 'the rest is untouched');
  assert.deepStrictEqual(pixelAt(modified, 195, 135), pixelAt(original, 195, 135));

  /* -- 5. the comparison (Original / Modified / Diff) --------------------- */
  const comparison = designService.compare(design.id, 'v2');
  assert.strictEqual(comparison.ok, true);
  assert.strictEqual(comparison.identical, false);
  assert.ok(comparison.meanDelta > 0, 'the difference is measured');

  /* -- 6. upscale --------------------------------------------------------- */
  const upscaled = designService.applyOps(design.id, [{ type: 'upscale', factor: 2 }], { label: '2x' });
  const big = decode(upscaled.versions[upscaled.versions.length - 1].path);
  assert.strictEqual(big.width, 400);
  assert.strictEqual(big.height, 280);

  /* -- 7. background removal ---------------------------------------------- */
  // Based on the original, so the coordinates are the original ones.
  const cut = designService.applyOps(design.id, [{ type: 'remove-background', tolerance: 20 }], {
    label: 'Cut out', baseVersionId: 'v1',
  });
  const cutImage = decode(cut.versions[cut.versions.length - 1].path);
  assert.strictEqual(cutImage.width, 200, 'the cut is based on the original');
  assert.strictEqual(pixelAt(cutImage, 5, 5)[3], 0, 'the background became transparent');
  assert.strictEqual(pixelAt(cutImage, 100, 70)[3], 255, 'the subject stayed opaque');

  /* -- 8. editing the text in the image (DSN-06) -------------------------- */
  const textEdited = designService.applyOps(design.id, [{
    type: 'edit-text',
    region: { x: 60, y: 55, width: 80, height: 30 },
    text: 'NEW',
    colour: '#102030',
    fontSize: 22,
  }], { label: 'New text', baseVersionId: 'v1' });
  const textImage = decode(textEdited.versions[textEdited.versions.length - 1].path);
  // The region is no longer the original red.
  const centre = pixelAt(textImage, 100, 70);
  assert.notDeepStrictEqual(centre, [220, 30, 40, 255], 'the old text was replaced');
  // Something was actually drawn.
  let dark = 0;
  for (let y = 55; y < 85; y += 1) {
    for (let x = 60; x < 140; x += 1) {
      const [r, g, b] = pixelAt(textImage, x, y);
      if (r < 90 && g < 90 && b < 110) dark += 1;
    }
  }
  assert.ok(dark > 20, `the new text was drawn (${dark} dark pixels)`);
  // And the area outside the region is untouched.
  assert.deepStrictEqual(pixelAt(textImage, 5, 5), [255, 255, 255, 255]);

  /* -- 9. a reference image (DSN-05) -------------------------------------- */
  // A solid blue square, so the composite is unmistakable.
  const referencePath = path.join(tmp, 'reference.png');
  const referenceImage = imageOps.createImage(60, 40, [20, 80, 220, 255]);
  fs.writeFileSync(referencePath, imageOps.encodePNG(referenceImage.data, 60, 40));
  const ref = designService.addReference(design.id, referencePath);
  assert.ok(ref.id);
  assert.strictEqual(designService.get(design.id).references.length, 1);
  const composed = designService.applyOps(design.id, [{
    type: 'composite-reference', referenceId: ref.id, x: 10, y: 10, width: 40, height: 30,
  }], { label: 'With reference', baseVersionId: 'v1' });
  const composedImage = decode(composed.versions[composed.versions.length - 1].path);
  assert.deepStrictEqual(pixelAt(composedImage, 30, 25), [20, 80, 220, 255], 'the reference was composited');
  assert.deepStrictEqual(pixelAt(composedImage, 100, 70), [220, 30, 40, 255], 'the rest of the canvas is intact');
  assert.throws(() => designService.applyOps(design.id, [
    { type: 'composite-reference', referenceId: 'nope' },
  ]), /unknown reference image/);

  /* -- 10. crop and rotate ------------------------------------------------ */
  const cropped = designService.applyOps(design.id, [{ type: 'crop', x: 10, y: 10, width: 80, height: 60 }], { baseVersionId: 'v1' });
  const croppedImage = decode(cropped.versions[cropped.versions.length - 1].path);
  assert.strictEqual(croppedImage.width, 80);
  assert.strictEqual(croppedImage.height, 60);
  const rotated = designService.applyOps(design.id, [{ type: 'rotate', degrees: 90 }], { baseVersionId: 'v1' });
  const rotatedImage = decode(rotated.versions[rotated.versions.length - 1].path);
  // The original is 200×140, so a quarter turn makes it 140×200.
  assert.strictEqual(rotatedImage.width, 140);
  assert.strictEqual(rotatedImage.height, 200);

  /* -- 11. an unknown operation is refused -------------------------------- */
  assert.throws(() => designService.applyOps(design.id, [{ type: 'make-coffee' }]), /unknown operation/);
  assert.throws(() => designService.applyOps(design.id, []), /no operations/);

  /* -- 12. text extraction (DSN-06) --------------------------------------- */
  const extracted = designService.extractTextElements(design.id);
  assert.ok(Array.isArray(extracted.elements));
  if (extracted.ok) {
    assert.ok(extracted.elements.length >= 1);
    assert.ok(extracted.elements[0].width > 0);
  } else {
    assert.match(extracted.reason, /no text|not built/);
  }

  /* -- 13. listing and removal -------------------------------------------- */
  assert.ok(designService.list().some((d) => d.id === design.id));
  assert.strictEqual(designService.remove(design.id).removed, true);
  assert.strictEqual(designService.get(design.id), null);
  assert.strictEqual(designService.remove(design.id).removed, false);

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('design test: ALL OK');
}
run().catch((e) => { console.error(e); process.exit(1); });
