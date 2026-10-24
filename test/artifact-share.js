'use strict';
/* Artifact sharing — the canvas share state behind the UI.
 *
 *  - the share of an artifact starts private
 *  - the visibility can be changed
 *  - the share file is one self-contained HTML document
 *  - the IPC namespace exposes the same operations
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qx-share-'));
process.env.QUANSIOX_USER_DATA_DIR = tmp;

const { artifactService } = require('../src/main/services/artifactService');
const { canvasService } = require('../src/main/services/canvasService');
const { grokCompatService } = require('../src/main/services/grokCompat/grokCompatService');

(async () => {
  const artifact = artifactService.save({ title: 'Budget', html: '<h1>Budget</h1><script>draw()</script>' });

  // the share starts private
  const share = canvasService.getShare({ kind: 'store', storeId: 'local', canvasId: artifact.id });
  assert.equal(share.kind, 'ready');
  assert.equal(share.access.visibility, 'private');

  // the visibility can be changed
  const changed = canvasService.setVisibility({ kind: 'store', storeId: 'local', canvasId: artifact.id }, 'public');
  assert.equal(changed.access.visibility, 'public');

  // the share file is one self-contained document
  const exported = canvasService.exportShareFile(artifact.id);
  assert.ok(fs.existsSync(exported.path));
  const html = fs.readFileSync(exported.path, 'utf8');
  assert.ok(html.includes('<h1>Budget</h1>'));
  assert.ok(html.includes('draw()'), 'the script came along — the file is self-contained');
  assert.equal(exported.visibility, 'public');

  // the same through the compatible surface
  const viaApi = await grokCompatService.dispatch('getCanvasShare', { locator: { kind: 'store', storeId: 'local', canvasId: artifact.id } });
  assert.equal(viaApi.access.visibility, 'public');

  console.log('artifact-share test: ALL OK (private/public/export/self-contained/grok surface)');
})().catch((e) => { console.error(e); process.exit(1); });
