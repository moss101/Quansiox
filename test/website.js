'use strict';
/* Website Builder test — the local-first website surface.
 *
 * Covers the locally-doable documented behaviour:
 *   - scaffolding an app on disk (WB getting-started);
 *   - editing and reading the files;
 *   - code control: every file plus a downloadable bundle (WB code-control);
 *   - make a copy, with the publishing state reset (WB make-a-copy);
 *   - the SEO audit and its fixes (WB seo);
 *   - access control enforced by the preview server (WB access-control);
 *   - local analytics (WB project-analytics);
 *   - notification rules (WB notifications);
 *   - schedules (WB schedules);
 *   - publishing: a static bundle, a preview URL and the DNS records.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qx-website-'));
process.env.QUANSIOX_USER_DATA_DIR = tmp;
process.env.QUANSIOX_TEST_USERDATA = tmp;

const { websiteService } = require('../src/main/services/websiteService');
const { settingsService } = require('../src/main/services/settingsService');

async function run() {
  settingsService.save({ workspaceRoot: tmp });

  /* -- 1. scaffolding ----------------------------------------------------- */
  const site = websiteService.create({ name: 'Landing Page', description: 'A page for the product.' });
  assert.ok(site.id.startsWith('web_'));
  assert.strictEqual(site.name, 'Landing Page');
  assert.ok(fs.existsSync(path.join(site.directory, 'index.html')));
  assert.ok(fs.existsSync(path.join(site.directory, 'styles.css')));
  assert.ok(fs.existsSync(path.join(site.directory, 'app.js')));
  assert.ok(site.files.length >= 4);
  assert.throws(() => websiteService.create({ name: '  ' }), /needs a name/);

  /* -- 2. files ----------------------------------------------------------- */
  const read = websiteService.readFile(site.id, 'index.html');
  assert.match(read.content, /Landing Page/);
  assert.strictEqual(read.binary, false);
  websiteService.writeFile(site.id, 'extra/page.html', '<h1>Extra</h1>');
  assert.ok(websiteService.readFile(site.id, 'extra/page.html').content.includes('Extra'));
  assert.throws(() => websiteService.readFile(site.id, '../../etc/passwd'), /escapes the site directory/);
  assert.throws(() => websiteService.writeFile(site.id, '/etc/passwd', 'x'), /escapes the site directory/);
  assert.strictEqual(websiteService.deleteFile(site.id, 'extra/page.html').deleted, true);

  /* -- 3. code control ---------------------------------------------------- */
  const control = websiteService.codeControl(site.id);
  assert.ok(control.files.length >= 4);
  assert.ok(control.totalBytes > 0);
  assert.ok(fs.existsSync(control.zipPath), 'the codebase downloads as a zip');
  const { readZip } = require('../src/shared/zipReader');
  const entries = readZip(fs.readFileSync(control.zipPath));
  assert.ok(entries.has('index.html'));
  assert.ok(entries.has('app.js'));

  /* -- 4. make a copy ----------------------------------------------------- */
  const copy = websiteService.makeCopy(site.id, { name: 'Landing Copy' });
  assert.strictEqual(copy.name, 'Landing Copy');
  assert.notStrictEqual(copy.directory, site.directory);
  assert.ok(fs.existsSync(path.join(copy.directory, 'index.html')), 'the code came across');
  assert.strictEqual(copy.publishedAt, null, 'a copy is not published');
  assert.strictEqual(copy.domain, null, 'a copy has no domain');
  assert.strictEqual(copy.analytics.views, 0, 'a copy starts with no analytics');
  assert.strictEqual(copy.schedules.length, 0, 'a copy has no schedules');

  /* -- 5. SEO ------------------------------------------------------------- */
  const audit = websiteService.seoAudit(site.id);
  assert.ok(audit.total >= 9);
  assert.ok(audit.score >= 0 && audit.score <= 100);
  assert.ok(audit.checks.some((check) => check.id === 'title'));
  assert.ok(audit.checks.find((check) => check.id === 'title').pass, 'the scaffold has a title');
  assert.ok(audit.suggestions.length >= 0);

  const applied = websiteService.applySeo(site.id, {
    description: 'A much longer description that should satisfy the description check in the audit.',
    canonical: 'https://example.com',
    robots: 'index,follow',
    sitemap: true,
  });
  assert.strictEqual(applied.seo.canonical, 'https://example.com');
  assert.ok(fs.existsSync(path.join(site.directory, 'robots.txt')));
  assert.ok(fs.existsSync(path.join(site.directory, 'sitemap.xml')));
  const robots = fs.readFileSync(path.join(site.directory, 'robots.txt'), 'utf8');
  assert.match(robots, /User-agent: \*/);
  assert.match(robots, /Sitemap: https:\/\/example\.com\/sitemap\.xml/);
  const sitemap = fs.readFileSync(path.join(site.directory, 'sitemap.xml'), 'utf8');
  assert.match(sitemap, /<urlset/);
  assert.match(sitemap, /<loc>https:\/\/example\.com\/index\.html<\/loc>/);
  const html = fs.readFileSync(path.join(site.directory, 'index.html'), 'utf8');
  assert.match(html, /rel="canonical"/);
  const after = websiteService.seoAudit(site.id);
  assert.ok(after.score >= audit.score, 'the fixes do not make the score worse');

  /* -- 6. access control -------------------------------------------------- */
  const open = websiteService.checkAccess({ access: { mode: 'public' } }, {});
  assert.strictEqual(open.allowed, true);
  const tokenAccess = websiteService.setAccess(site.id, { mode: 'token' });
  assert.ok(tokenAccess.token);
  assert.strictEqual(websiteService.checkAccess({ access: tokenAccess }, { token: tokenAccess.token }).allowed, true);
  assert.strictEqual(websiteService.checkAccess({ access: tokenAccess }, { token: 'wrong' }).allowed, false);
  const allowlist = websiteService.setAccess(site.id, { mode: 'allowlist', allowlist: ['ada@example.com'] });
  assert.strictEqual(websiteService.checkAccess({ access: allowlist }, { identity: 'ada@example.com' }).allowed, true);
  assert.strictEqual(websiteService.checkAccess({ access: allowlist }, { identity: 'eve@example.com' }).allowed, false);
  websiteService.setAccess(site.id, { mode: 'public' });

  /* -- 7. analytics ------------------------------------------------------- */
  websiteService.recordView(site.id, '/');
  websiteService.recordView(site.id, '/');
  websiteService.recordView(site.id, '/about.html');
  const analytics = websiteService.analyticsSummary(site.id);
  assert.strictEqual(analytics.views, 3);
  assert.strictEqual(analytics.uniquePages, 2);
  assert.strictEqual(analytics.topPage, '/');
  assert.ok(analytics.pages.find((page) => page.page === '/').count === 2);

  /* -- 8. notifications --------------------------------------------------- */
  const rule = websiteService.addNotification(site.id, { event: 'published', channel: 'in-app', target: 'the team' });
  assert.ok(rule.id.startsWith('ntf_'));
  assert.strictEqual(websiteService.get(site.id).notifications.length, 1);
  const fired = websiteService.fireNotifications(site.id, 'published');
  assert.strictEqual(fired.length, 1);
  assert.strictEqual(websiteService.fireNotifications(site.id, 'changed').length, 0);
  assert.strictEqual(websiteService.removeNotification(site.id, rule.id).removed, true);

  /* -- 9. schedules ------------------------------------------------------- */
  const schedule = websiteService.addSchedule(site.id, { cron: '0 9 * * *', prompt: 'Review the site.' });
  assert.ok(schedule.id.startsWith('sch_'));
  assert.strictEqual(schedule.cron, '0 9 * * *');
  assert.throws(() => websiteService.addSchedule(site.id, { cron: 'not a cron' }));
  assert.strictEqual(websiteService.removeSchedule(site.id, schedule.id).removed, true);

  /* -- 10. publishing ----------------------------------------------------- */
  const published = await websiteService.publish(site.id, { domain: 'example.com' });
  assert.ok(fs.existsSync(published.bundlePath), 'a static bundle is produced');
  assert.ok(published.previewUrl, 'a preview URL is started');
  assert.strictEqual(published.domain, 'example.com');
  assert.ok(published.dnsRecords.some((record) => record.type === 'CNAME'));
  assert.ok(published.dnsRecords.some((record) => record.type === 'TXT'));

  // The preview server really serves the site and counts the views.
  const response = await fetch(`${published.previewUrl}/`);
  assert.strictEqual(response.status, 200);
  const body = await response.text();
  assert.match(body, /Landing Page/);
  const afterPublish = websiteService.analyticsSummary(site.id);
  assert.ok(afterPublish.views > analytics.views, 'the preview counts a view');

  /* -- 11. the preview server enforces the access rules ------------------- */
  websiteService.setAccess(site.id, { mode: 'token' });
  const token = websiteService.get(site.id).access.token;
  const denied = await fetch(`${published.previewUrl}/`);
  assert.strictEqual(denied.status, 401, 'a protected site refuses an anonymous request');
  const allowed = await fetch(`${published.previewUrl}/?token=${token}`);
  assert.strictEqual(allowed.status, 200, 'and serves it with the token');
  websiteService.setAccess(site.id, { mode: 'public' });

  /* -- 12. listing and removal -------------------------------------------- */
  assert.ok(websiteService.list().some((entry) => entry.id === site.id));
  websiteService.stopPreviewServer(site.id);
  assert.strictEqual(websiteService.remove(site.id).removed, true);
  assert.strictEqual(websiteService.get(site.id), null);

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('website test: ALL OK');
}
run().catch((e) => { console.error(e); process.exit(1); });
