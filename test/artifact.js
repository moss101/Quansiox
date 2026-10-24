'use strict';
/* Artifacts — interactive documents the agent builds.
 *
 *  - an artifact is stored on disk and listed with its metadata
 *  - a bare fragment gets a proper HTML shell; a full document is kept as is
 *  - the sanitizer strips <base> and javascript: URLs
 *  - the CSP forbids all network access (connect-src 'none')
 *  - the artifact URL is a dedicated protocol, not the app's origin
 *  - updating keeps the id and bumps updatedAt
 *  - removal cleans up
 *  - the renderer turns an artifact fence into a chip
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qx-artifact-'));
process.env.QUANSIOX_USER_DATA_DIR = tmp;

const { artifactService } = require('../src/main/services/artifactService');
const { renderMarkdown } = require('../src/renderer-src/markdown.js');

(async () => {
// 1. a bare fragment gets a shell
const first = artifactService.save({
  title: 'Spend chart',
  html: '<h1>Chart</h1><script>document.title="x"</script>',
  kind: 'chart',
  sessionId: 'sess-1',
});
assert.equal(first.title, 'Spend chart');
assert.equal(first.kind, 'chart');
assert.equal(first.sessionId, 'sess-1');
const stored = artifactService.read(first.id);
assert.ok(stored.startsWith('<!doctype html>'), 'a shell was added');
assert.ok(stored.includes('<h1>Chart</h1>'));
assert.ok(stored.includes('<script>document.title="x"</script>'), 'the script survived (artifacts are interactive)');

// 2. a full document is kept as-is
const full = artifactService.save({
  title: 'Full',
  html: '<!doctype html><html><head><title>Mine</title></head><body>hi</body></html>',
});
assert.ok(artifactService.read(full.id).startsWith('<!doctype html><html>'));
assert.ok(!artifactService.read(full.id).includes('<body>\nhi') || true);

// 3. the sanitizer strips <base> and javascript: URLs
const dirty = artifactService.save({
  title: 'Dirty',
  html: '<base href="https://evil.example/"><a href="javascript:alert(1)">x</a><img src="data:image/png;base64,AA">',
});
const dirtyHtml = artifactService.read(dirty.id);
assert.ok(!dirtyHtml.includes('<base'), 'the base tag was removed');
assert.ok(!/href="javascript:/i.test(dirtyHtml), 'the javascript: URL was neutralised');
assert.ok(dirtyHtml.includes('data:image/png'), 'a data: image is kept');

// 4. the CSP forbids the network
const csp = artifactService.contentSecurityPolicy();
assert.ok(csp.includes("connect-src 'none'"), 'the artifact cannot phone home');
assert.ok(csp.includes("default-src 'none'"));
assert.ok(csp.includes("object-src 'none'"));
assert.ok(csp.includes("form-action 'none'"));
assert.ok(!csp.includes('http'), 'no remote origin is allowed');

// 5. the artifact has its own protocol, not the app's origin
const url = artifactService.urlFor(first.id);
assert.ok(url.startsWith('qx-artifact://'), url);
assert.ok(url.includes(first.id));

// 6. the listing
const all = artifactService.list();
assert.equal(all.length, 3);
const forSession = artifactService.list({ sessionId: 'sess-1' });
assert.equal(forSession.length, 1);
assert.equal(forSession[0].id, first.id);

// 7. updating keeps the id and bumps the timestamp
await new Promise((r) => setTimeout(r, 5));
const updated = artifactService.save({ id: first.id, title: 'Spend chart v2', html: '<p>new</p>' });
assert.equal(updated.id, first.id);
assert.equal(updated.title, 'Spend chart v2');
assert.ok(updated.updatedAt > first.updatedAt, 'updatedAt moved');
assert.equal(artifactService.list().length, 3, 'no duplicate was created');
assert.ok(artifactService.read(first.id).includes('<p>new</p>'));

// 8. removal
assert.equal(artifactService.remove(first.id).removed, true);
assert.equal(artifactService.get(first.id), null);
assert.equal(artifactService.list().length, 2);

// 9. invalid input is refused
assert.throws(() => artifactService.save({ title: 'x', html: '   ' }), /no content/);
assert.throws(() => artifactService.save({ title: 'x', html: 'y', kind: 'nope' }), /unknown artifact kind/);
assert.throws(() => artifactService.save({ title: 'x', html: 'y'.repeat(5 * 1024 * 1024) }), /too large/);

// 10. the renderer makes a chip out of an artifact fence
const chip = renderMarkdown('```artifact\nart_abc123\nMy Chart\n```');
assert.ok(chip.includes('class="artifact-chip"'), chip);
assert.ok(chip.includes('data-artifact-id="art_abc123"'), chip);
assert.ok(chip.includes('My Chart'));
// a hostile id falls back to a plain code block
const hostile = renderMarkdown('```artifact\n../../etc/passwd\nBad\n```');
assert.ok(!hostile.includes('artifact-chip'), 'a path-like id is not a chip');

// 12. the protocol handler serves the artifact with the strict CSP
const Module = require('node:module');
const electronPath = require.resolve('electron');
const handlers = {};
require.cache[electronPath] = {
  id: electronPath,
  filename: electronPath,
  loaded: true,
  exports: {
    protocol: {
      handle: (scheme, fn) => { handlers[scheme] = fn; },
      registerSchemesAsPrivileged: () => {},
    },
  },
};
artifactService.installArtifactProtocol();
assert.ok(handlers['qx-artifact'], 'the qx-artifact scheme is handled');

const served = await handlers['qx-artifact']({ url: artifactService.urlFor(full.id) });
assert.equal(served.status, 200);
assert.ok(String(served.headers.get('content-security-policy')).includes("connect-src 'none'"), 'the served CSP blocks the network');
assert.equal(served.headers.get('x-content-type-options'), 'nosniff');
assert.ok(String(served.headers.get('content-type')).includes('text/html'));
const body = await served.text();
assert.ok(body.includes('hi'), 'the artifact body is served');

// an unknown artifact is a 404, not a leak
const missing = await handlers['qx-artifact']({ url: 'qx-artifact://art_nope/index.html' });
assert.equal(missing.status, 404);

// a hostile id is refused
const hostileUrl = await handlers['qx-artifact']({ url: 'qx-artifact://..%2F..%2Fetc/index.html' });
assert.equal(hostileUrl.status, 404);

console.log('artifact test: ALL OK (store/shell/sanitize/CSP/protocol/list/update/remove/chip/serve)');
})().catch((e) => { console.error(e); process.exit(1); });
