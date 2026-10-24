'use strict';
/* The Grok-compatible canvas + library + meetings surface, implemented
 * locally on top of the artifact and document stores.
 *
 *  - a canvas is an artifact; the locator names it
 *  - the share state has a visibility, principals and a state token
 *  - a stale state token cannot overwrite a newer share
 *  - a canvas can be renamed and given an address
 *  - a public canvas exports as one self-contained HTML file
 *  - the library documents, the attachments and the meetings answer too
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qx-canvas-'));
process.env.QUANSIOX_USER_DATA_DIR = tmp;

const { artifactService } = require('../src/main/services/artifactService');
const { canvasService } = require('../src/main/services/canvasService');
const { grokCompatService } = require('../src/main/services/grokCompat/grokCompatService');

(async () => {
  // 1. a canvas is an artifact, named by a locator
  const artifact = artifactService.save({ title: 'Roadmap', html: '<h1>Roadmap</h1>' });
  const locator = { kind: 'store', storeId: 'local', canvasId: artifact.id };

  const share = canvasService.getShare(locator);
  assert.equal(share.kind, 'ready');
  assert.equal(share.access.visibility, 'private');
  assert.equal(share.access.principals.length, 0);
  assert.ok(share.access.stateToken, 'the share has a state token');
  assert.equal(share.access.title, 'Roadmap');
  assert.equal(share.access.store, 'local');

  // 2. the visibility can be changed
  const shared = canvasService.setVisibility(locator, 'team-view');
  assert.equal(shared.access.visibility, 'team-view');
  assert.equal(canvasService.getShare(locator).access.visibility, 'team-view');
  assert.throws(() => canvasService.setVisibility(locator, 'nonsense'), /visibility must be/);

  // 3. the principals can be set, guarded by the state token
  const current = canvasService.getShareAccess(locator).access;
  const applied = canvasService.updateShareAccess(locator, [
    { kind: 'user', userId: 42 },
    { kind: 'group', groupId: 'design' },
    { kind: 'user', userId: 'not-a-number' },
  ], current.stateToken);
  assert.equal(applied.kind, 'applied');
  assert.equal(applied.access.principals.length, 2, 'the malformed principal was dropped');
  assert.deepEqual(applied.access.principals[0], { kind: 'user', userId: 42 });

  // a stale token is refused — and says what the current state is
  const stale = canvasService.updateShareAccess(locator, [{ kind: 'user', userId: 7 }], current.stateToken);
  assert.equal(stale.kind, 'changed');
  assert.equal(stale.access.principals.length, 2, 'the newer share was not overwritten');
  // the visibility change also rotated the token
  assert.notEqual(current.stateToken, share.access.stateToken, 'the token rotates when the share changes');

  // 4. the canvas can be renamed and given an address
  const renamed = canvasService.rename(locator, 'The roadmap');
  assert.equal(renamed.title, 'The roadmap');
  assert.equal(artifactService.get(artifact.id).title, 'The roadmap');
  const addressed = canvasService.setPageAddress(locator, 'q3-roadmap');
  assert.equal(addressed.pageAddress, 'q3-roadmap');
  assert.throws(() => canvasService.setPageAddress(locator, 'not a slug!'), /slug/);

  // 5. an unknown canvas is reported honestly
  assert.equal(canvasService.getShare({ kind: 'store', storeId: 'local', canvasId: 'art_nope' }).kind, 'unavailable');
  assert.throws(() => canvasService.getShare(null), /locator is required/);
  assert.throws(() => canvasService.getShare({}), /canvasId/);

  // 6. a public canvas exports as one self-contained file
  const exported = canvasService.exportShareFile(artifact.id);
  assert.equal(exported.kind, 'ready');
  assert.ok(fs.existsSync(exported.path));
  assert.ok(fs.readFileSync(exported.path, 'utf8').includes('<h1>Roadmap</h1>'));

  // 7. the Grok-compatible surface answers with the same semantics
  const viaApi = await grokCompatService.dispatch('getCanvasShare', { locator });
  assert.equal(viaApi.status, 'ok');
  assert.equal(viaApi.access.visibility, 'team-view');
  assert.equal(viaApi.access.title, 'The roadmap');

  const viaVisibility = await grokCompatService.dispatch('setCanvasVisibility', { locator, visibility: 'public' });
  assert.equal(viaVisibility.status, 'ok');
  assert.equal(viaVisibility.access.visibility, 'public');

  const viaAccess = await grokCompatService.dispatch('getCanvasShareAccess', { locator });
  assert.equal(viaAccess.status, 'ok');
  assert.equal(viaAccess.access.principals.length, 2);

  const viaUpdate = await grokCompatService.dispatch('updateCanvasShareAccess', {
    locator,
    principals: [{ kind: 'user', userId: 99 }],
    expectedStateToken: viaAccess.access.stateToken,
  });
  assert.equal(viaUpdate.status, 'ok');
  assert.equal(viaUpdate.kind, 'applied');

  const viaRename = await grokCompatService.dispatch('renameCanvas', { locator, title: 'Renamed again' });
  assert.equal(viaRename.status, 'ok');
  assert.equal(viaRename.title, 'Renamed again');

  const viaAddress = await grokCompatService.dispatch('setCanvasPageAddress', { locator, slug: 'new-slug' });
  assert.equal(viaAddress.status, 'ok');
  assert.equal(viaAddress.pageAddress, 'new-slug');

  // 8. the library documents answer
  const saved = await grokCompatService.dispatch('saveDocument', { title: 'Notes', content: '# Notes\n\nHello.' });
  assert.equal(saved.status, 'ok');
  assert.ok(saved.document.id);
  const got = await grokCompatService.dispatch('getDocument', { id: saved.document.id });
  assert.equal(got.status, 'ok');
  assert.ok(got.document.content.includes('Hello.'));
  const listed = await grokCompatService.dispatch('listLibraryDocs', {});
  assert.ok(listed.documents.some((d) => d.id === saved.document.id));
  const right = await grokCompatService.dispatch('getDocumentEditRight', { locator: { storeId: 'local', documentId: saved.document.id } });
  assert.equal(right.editable, true, 'a local document is always editable');
  assert.equal(right.found, true);

  // 9. the meetings answer
  const meetings = await grokCompatService.dispatch('listMeetings', {});
  assert.equal(meetings.status, 'ok');
  assert.ok(Array.isArray(meetings.meetings));
  const census = await grokCompatService.dispatch('meetingCensus', {});
  assert.equal(census.status, 'ok');
  assert.equal(typeof census.total, 'number');

  console.log('canvas test: ALL OK (share/visibility/principals/token guard/rename/address/export/grok surface/library/meetings)');
})().catch((e) => { console.error(e); process.exit(1); });
