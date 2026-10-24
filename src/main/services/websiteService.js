'use strict';
/**
 * Website Builder — the local-first implementation of the parts of Manus'
 * Website Builder that can honestly run on the user's own machine.
 *
 * The documented product is large: it plans an app, generates the code,
 * previews it, publishes it to Google Cloud Run, provisions a MySQL
 * database and object storage, wires a Stripe sandbox, serves AI features
 * from a built-in gateway, adds a custom domain, tracks analytics and pushes
 * to GitHub. Most of that is **cloud-bound** — it needs Manus' hosted
 * infrastructure and cannot be reproduced by a local app.
 *
 * What this module owns is the local core, and it is the part a
 * local-first product can do *better*, because the user's own files, their
 * own database file and their own machine are the deployment target:
 *
 *   - **scaffolding** an app in the workspace (WB getting-started);
 *   - **editing and previewing** it — a live local preview server;
 *   - **code control** — read every file, copy it, download the whole
 *     codebase as a ZIP (WB code-control);
 *   - **make a copy** of a project (WB make-a-copy);
 *   - **SEO** — meta tags, canonical URL, robots.txt, sitemap.xml and a
 *     real health score (WB seo);
 *   - **access control** — per-page rules the preview server enforces
 *     (WB access-control);
 *   - **analytics** — local page-view counting (WB project-analytics);
 *   - **notifications** — in-app rules for a published change (WB notifications);
 *   - **schedules** — a cron that rebuilds the site (WB schedules);
 *   - **publishing** — a static bundle plus a local static server, and the
 *     DNS records a real deployment would need.
 *
 * Everything that genuinely requires Manus' cloud (Cloud Run, MySQL
 * provisioning, the Stripe sandbox, App Store Connect, the built-in AI
 * gateway) is left out on purpose rather than faked.
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const http = require('node:http');

const { buildZip } = require('../../shared/zip');

/* ------------------------------------------------------------------ store */

function userDataDir() {
  return require('./userData').userDataDir();
}
function sitesDir() { return path.join(userDataDir(), 'websites'); }
function siteFile(id) {
  if (!/^web_[A-Za-z0-9_-]{1,64}$/.test(String(id || ''))) throw new Error('invalid site id');
  return path.join(sitesDir(), `${id}.json`);
}
function newId() { return `web_${crypto.randomBytes(9).toString('base64url')}`; }

function load(id) {
  try { return JSON.parse(fs.readFileSync(siteFile(id), 'utf8')); } catch { return null; }
}
function save(site) {
  fs.mkdirSync(sitesDir(), { recursive: true });
  fs.writeFileSync(siteFile(site.id), JSON.stringify(site, null, 2), { mode: 0o600 });
  return site;
}

/** The public shape of a site. */
function reduced(site) {
  if (!site) return null;
  return {
    id: site.id,
    name: site.name,
    description: site.description,
    stack: site.stack,
    directory: site.directory,
    files: listFiles(site.id).map((f) => ({ path: f.path, bytes: f.bytes })),
    seo: site.seo ?? {},
    access: site.access ?? { mode: 'public' },
    analytics: site.analytics ?? { views: 0, pages: {} },
    notifications: site.notifications ?? [],
    schedules: site.schedules ?? [],
    domain: site.domain ?? null,
    publishedAt: site.publishedAt ?? null,
    previewUrl: site.previewUrl ?? null,
    createdAt: site.createdAt,
    updatedAt: site.updatedAt,
  };
}

/* -------------------------------------------------------------- workspace */

function siteDir(id) {
  if (!/^web_[A-Za-z0-9_-]{1,64}$/.test(String(id || ''))) throw new Error('invalid site id');
  return path.join(sitesDir(), id, 'site');
}

/** The workspace a site lives in — inside the user's own workspace. */
function workspaceDir(name) {
  const { settingsService } = require('./settingsService');
  const root = settingsService.load().workspaceRoot || process.cwd();
  return path.join(root, 'sites', name);
}

/* -------------------------------------------------------------- scaffold */

const SCAFFOLD = {
  'index.html': (name, description) => `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${name}</title>
  <meta name="description" content="${description}" />
  <link rel="stylesheet" href="styles.css" />
</head>
<body>
  <header class="hero">
    <h1>${name}</h1>
    <p>${description}</p>
    <button id="cta" type="button">Get started</button>
  </header>
  <main id="content"></main>
  <script src="app.js"></script>
</body>
</html>
`,
  'styles.css': () => `:root {
  --bg: #0b0e14;
  --fg: #e7eaf0;
  --muted: #8b93a7;
  --accent: #5b8def;
}
* { box-sizing: border-box; }
body {
  margin: 0; background: var(--bg); color: var(--fg);
  font: 16px/1.6 system-ui, -apple-system, "Segoe UI", sans-serif;
}
.hero { padding: 96px 24px; text-align: center; }
.hero h1 { font-size: clamp(32px, 6vw, 64px); margin: 0 0 12px; font-weight: 300; }
.hero p { color: var(--muted); max-width: 46ch; margin: 0 auto 28px; }
button {
  background: var(--accent); color: #fff; border: 0; border-radius: 10px;
  padding: 12px 22px; font: inherit; cursor: pointer;
}
main { padding: 0 24px 96px; }
`,
  'app.js': () => `// The site's behaviour. Edit freely — this is your code.
const content = document.getElementById('content');
content.textContent = 'It works.';

document.getElementById('cta')?.addEventListener('click', () => {
  content.textContent = 'Clicked.';
});
`,
  'README.md': (name) => `# ${name}

Built with Quansiox.

    index.html    the page
    styles.css    the styles
    app.js        the behaviour

Open the preview from the Quansiox app, or serve this directory with any
static file server.
`,
};

/**
 * Create a site: a scaffolded app on disk, plus the project record.
 *
 * @param {object} spec { name, description, stack, directory }
 */
function create(spec = {}) {
  const name = String(spec.name ?? '').trim().slice(0, 120);
  if (!name) throw new Error('a site needs a name');
  const description = String(spec.description ?? '').trim().slice(0, 400);
  const stack = ['static', 'vanilla'].includes(spec.stack) ? spec.stack : 'static';
  const id = newId();
  const directory = spec.directory
    ? path.resolve(String(spec.directory))
    : workspaceDir(name.replace(/[^A-Za-z0-9-_ ]/g, '').trim().replace(/\s+/g, '-').toLowerCase() || id);

  fs.mkdirSync(directory, { recursive: true });
  for (const [file, template] of Object.entries(SCAFFOLD)) {
    fs.writeFileSync(path.join(directory, file), template(name, description), 'utf8');
  }

  const now = Date.now();
  const site = {
    id,
    name,
    description,
    stack,
    directory,
    seo: {
      title: name,
      description,
      canonical: null,
      ogImage: null,
      robots: 'index,follow',
      twitterCard: 'summary_large_image',
      sitemap: true,
    },
    access: { mode: 'public', token: null, allowlist: [], rules: [] },
    analytics: { views: 0, pages: {}, startedAt: now },
    notifications: [],
    schedules: [],
    domain: null,
    publishedAt: null,
    createdAt: now,
    updatedAt: now,
  };
  save(site);
  return reduced(site);
}

function get(id) {
  return reduced(load(id));
}

function list() {
  try {
    return fs.readdirSync(sitesDir())
      .filter((f) => f.endsWith('.json'))
      .map((f) => reduced(load(f.slice(0, -5))))
      .filter(Boolean)
      .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
  } catch {
    return [];
  }
}

function remove(id) {
  const site = load(id);
  if (!site) return { removed: false };
  try { fs.rmSync(path.join(sitesDir(), id), { recursive: true, force: true }); } catch { /* best effort */ }
  try { fs.rmSync(siteFile(id), { force: true }); } catch { /* best effort */ }
  return { removed: true, id };
}

/* ------------------------------------------------------------------ files */

const TEXT_EXTENSIONS = new Set([
  '.html', '.htm', '.css', '.js', '.mjs', '.cjs', 'jsx', 'ts', 'tsx', 'json',
  '.md', '.txt', '.yml', '.yaml', '.svg', '.xml', '.webmanifest',
]);

function safeRelativePath(input) {
  const text = String(input ?? '').replace(/\\/g, '/');
  // An absolute path is refused outright rather than silently turned into a
  // relative one — "write /etc/passwd" must not quietly become
  // "write <site>/etc/passwd".
  if (text.startsWith('/') || /^[A-Za-z]:/.test(text)) throw new Error('path escapes the site directory');
  const normalized = path.posix.normalize(text.replace(/^\/+/, ''));
  if (!normalized || normalized === '.' || normalized.startsWith('..') || normalized.includes('/../')) {
    throw new Error('path escapes the site directory');
  }
  return normalized;
}

/** Every file in the site directory. */
function listFiles(id) {
  const site = load(id);
  if (!site) return [];
  const out = [];
  const walk = (dir, prefix = '') => {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      const absolute = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(absolute, relative);
      else {
        let bytes = 0;
        try { bytes = fs.statSync(absolute).size; } catch { /* ignore */ }
        out.push({ path: relative, bytes });
      }
    }
  };
  walk(site.directory);
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

/** Read one file of the site. */
function readFile(id, filePath) {
  const site = load(id);
  if (!site) throw new Error('site not found');
  const relative = safeRelativePath(filePath);
  const absolute = path.join(site.directory, relative);
  const buffer = fs.readFileSync(absolute);
  const extension = path.extname(relative).toLowerCase();
  return {
    path: relative,
    bytes: buffer.length,
    binary: !TEXT_EXTENSIONS.has(extension),
    content: TEXT_EXTENSIONS.has(extension) ? buffer.toString('utf8') : null,
    base64: TEXT_EXTENSIONS.has(extension) ? null : buffer.toString('base64'),
  };
}

/** Write one file of the site. */
function writeFile(id, filePath, content) {
  const site = load(id);
  if (!site) throw new Error('site not found');
  const relative = safeRelativePath(filePath);
  const absolute = path.join(site.directory, relative);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.writeFileSync(absolute, String(content ?? ''), 'utf8');
  site.updatedAt = Date.now();
  save(site);
  return { path: relative, bytes: fs.statSync(absolute).size };
}

/** Delete one file of the site. */
function deleteFile(id, filePath) {
  const site = load(id);
  if (!site) throw new Error('site not found');
  const relative = safeRelativePath(filePath);
  const absolute = path.join(site.directory, relative);
  if (!fs.existsSync(absolute)) return { deleted: false };
  fs.rmSync(absolute, { force: true });
  site.updatedAt = Date.now();
  save(site);
  return { deleted: true, path: relative };
}

/**
 * Code control (WB code-control): the whole codebase, and a download.
 *
 * @returns {{files: Array, zipPath: string|null, totalBytes: number}}
 */
function codeControl(id, { download = true } = {}) {
  const site = load(id);
  if (!site) throw new Error('site not found');
  const files = listFiles(id).map((entry) => {
    const read = readFile(id, entry.path);
    return {
      path: read.path,
      bytes: read.bytes,
      binary: read.binary,
      content: read.content,
      base64: read.base64,
    };
  });
  const totalBytes = files.reduce((sum, file) => sum + file.bytes, 0);
  let zipPath = null;
  if (download) {
    const dir = path.join(sitesDir(), id, 'exports');
    fs.mkdirSync(dir, { recursive: true });
    zipPath = path.join(dir, `${site.name.replace(/[^A-Za-z0-9-_]/g, '').slice(0, 40) || 'site'}.zip`);
    const entries = files.map((file) => ({
      name: file.path,
      data: file.binary ? Buffer.from(file.base64, 'base64') : Buffer.from(file.content, 'utf8'),
    }));
    fs.writeFileSync(zipPath, buildZip(entries));
  }
  return { files, zipPath, totalBytes };
}

/**
 * Make a copy of a project (WB make-a-copy).
 *
 * The docs describe exactly what a copy carries over — the code and the
 * secrets yes, the database schema only, and the publishing, domain and
 * chat history reset — so the copy follows the same rules.
 */
function makeCopy(id, { name, copyAnalytics = false } = {}) {
  const site = load(id);
  if (!site) throw new Error('site not found');
  const copyName = String(name ?? `${site.name} (copy)`).slice(0, 120);
  const copyId = newId();
  const directory = workspaceDir(copyName.replace(/[^A-Za-z0-9-_ ]/g, '').trim().replace(/\s+/g, '-').toLowerCase() || copyId);
  fs.mkdirSync(directory, { recursive: true });
  for (const entry of listFiles(id)) {
    const source = path.join(site.directory, entry.path);
    const target = path.join(directory, entry.path);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(source, target);
  }
  const now = Date.now();
  const copy = {
    ...JSON.parse(JSON.stringify(site)),
    id: copyId,
    name: copyName,
    directory,
    // A copy is not published, has no domain and no chat history.
    publishedAt: null,
    domain: null,
    previewUrl: null,
    schedules: [],
    notifications: [],
    analytics: copyAnalytics
      ? { ...site.analytics }
      : { views: 0, pages: {}, startedAt: now },
    createdAt: now,
    updatedAt: now,
  };
  save(copy);
  return reduced(copy);
}

/* -------------------------------------------------------------------- SEO */

/**
 * The SEO health of a site, and the fixes that can be applied locally.
 *
 * The score is a real checklist over the actual HTML — not a number that
 * always says 100.
 */
function seoAudit(id) {
  const site = load(id);
  if (!site) throw new Error('site not found');
  const checks = [];
  let html = '';
  try {
    html = fs.readFileSync(path.join(site.directory, 'index.html'), 'utf8');
  } catch { /* no index page */ }

  const has = (pattern) => pattern.test(html);
  checks.push({
    id: 'title', label: 'The page has a <title>',
    pass: has(/<title>[^<]{4,}<\/title>/i),
    fix: 'Add a <title> of at least 4 characters.',
  });
  checks.push({
    id: 'description', label: 'The page has a meta description',
    pass: has(/<meta[^>]+name=["']description["'][^>]+content=["'][^"']{50,}["']/i),
    fix: 'Add a meta description of 50–160 characters.',
  });
  checks.push({
    id: 'viewport', label: 'The page is mobile friendly',
    pass: has(/<meta[^>]+name=["']viewport["']/i),
    fix: 'Add the viewport meta tag.',
  });
  checks.push({
    id: 'og', label: 'The page has Open Graph tags',
    pass: has(/property=["']og:(title|image)["']/i),
    fix: 'Add og:title and og:image.',
  });
  checks.push({
    id: 'canonical', label: 'The page declares a canonical URL',
    pass: has(/<link[^>]+rel=["']canonical["']/i),
    fix: 'Add <link rel="canonical" href="…">.',
  });
  checks.push({
    id: 'lang', label: 'The page declares a language',
    pass: has(/<html[^>]+lang=["'][a-z-]{2}/i),
    fix: 'Add lang="…" to the <html> element.',
  });
  checks.push({
    id: 'h1', label: 'The page has exactly one <h1>',
    pass: (html.match(/<h1[\s>]/gi) ?? []).length === 1,
    fix: 'Use exactly one <h1> as the page heading.',
  });
  checks.push({
    id: 'alt', label: 'Every image has an alt attribute',
    pass: !/<img(?![^>]*\balt=)[^>]*>/i.test(html),
    fix: 'Give every <img> an alt attribute.',
  });
  checks.push({
    id: 'robots', label: 'robots.txt allows indexing',
    pass: site.seo?.robots?.startsWith('index') === true,
    fix: 'Set the robots directive to "index,follow".',
  });
  checks.push({
    id: 'sitemap', label: 'A sitemap is generated',
    pass: site.seo?.sitemap === true,
    fix: 'Turn the sitemap on.',
  });

  const passed = checks.filter((check) => check.pass).length;
  const score = Math.round((passed / checks.length) * 100);
  return {
    score,
    passed,
    total: checks.length,
    checks,
    suggestions: checks.filter((check) => !check.pass).map((check) => check.fix),
  };
}

/** Apply the SEO settings and regenerate robots.txt and sitemap.xml. */
function applySeo(id, patch = {}) {
  const site = load(id);
  if (!site) throw new Error('site not found');
  site.seo = { ...(site.seo ?? {}), ...patch };
  site.seo.robots = String(site.seo.robots ?? 'index,follow');
  site.seo.sitemap = site.seo.sitemap !== false;

  // robots.txt
  fs.writeFileSync(
    path.join(site.directory, 'robots.txt'),
    `User-agent: *\n${site.seo.robots}\n${site.seo.sitemap ? `Sitemap: ${site.seo.canonical ?? '/'}/sitemap.xml` : ''}\n`.trim(),
    'utf8'
  );
  // sitemap.xml
  const pages = listFiles(id).filter((f) => f.path.endsWith('.html')).map((f) => f.path);
  const base = site.seo.canonical ? site.seo.canonical.replace(/\/$/, '') : '';
  const urls = pages.map((page) => `  <url><loc>${base}/${page}</loc></url>`).join('\n');
  fs.writeFileSync(
    path.join(site.directory, 'sitemap.xml'),
    `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`,
    'utf8'
  );
  // The meta tags, straight into the page.
  const indexPath = path.join(site.directory, 'index.html');
  if (fs.existsSync(indexPath)) {
    let html = fs.readFileSync(indexPath, 'utf8');
    html = ensureMeta(html, 'description', site.seo.description);
    html = ensureMeta(html, 'og:title', site.seo.title ?? site.name, 'property');
    html = ensureMeta(html, 'og:description', site.seo.description);
    if (site.seo.canonical) {
      html = html.replace(/<link[^>]+rel=["']canonical["'][^>]*>/i, '');
      html = html.replace('</head>', `  <link rel="canonical" href="${site.seo.canonical}" />\n</head>`);
    }
    fs.writeFileSync(indexPath, html, 'utf8');
  }
  site.updatedAt = Date.now();
  save(site);
  return { seo: site.seo, audit: seoAudit(id) };
}

/** Add or replace a meta tag in a head. */
function ensureMeta(html, name, content, attribute = 'name') {
  if (!content) return html;
  const pattern = new RegExp(`<meta[^>]+${attribute}=["']${name}["'][^>]*>`, 'i');
  const tag = `<meta ${attribute}="${name}" content="${String(content).replace(/"/g, '&quot;')}" />`;
  if (pattern.test(html)) return html.replace(pattern, tag);
  return html.replace('</head>', `  ${tag}\n</head>`);
}

/* ---------------------------------------------------------- access control */

/**
 * Access rules for the preview server (WB access-control).
 *
 * The rules are enforced by the local server itself: a page can be public,
 * token-protected, password-protected or limited to an allow-list.
 */
function setAccess(id, access = {}) {
  const site = load(id);
  if (!site) throw new Error('site not found');
  const mode = ['public', 'token', 'password', 'allowlist'].includes(access.mode) ? access.mode : 'public';
  const next = {
    mode,
    token: mode === 'token' ? (access.token ?? crypto.randomBytes(16).toString('hex')) : null,
    password: mode === 'password' ? (access.password ?? crypto.randomBytes(8).toString('hex')) : null,
    allowlist: Array.isArray(access.allowlist) ? access.allowlist.map((a) => String(a)).slice(0, 200) : [],
    rules: Array.isArray(access.rules) ? access.rules.slice(0, 100) : [],
  };
  site.access = next;
  site.updatedAt = Date.now();
  save(site);
  return next;
}

/** Is this request allowed? */
function checkAccess(site, { token = null, password = null, identity = null } = {}) {
  const access = site.access ?? { mode: 'public' };
  if (access.mode === 'public') return { allowed: true };
  if (access.mode === 'token') {
    return token && token === access.token
      ? { allowed: true }
      : { allowed: false, status: 401, reason: 'a valid access token is required' };
  }
  if (access.mode === 'password') {
    return password && password === access.password
      ? { allowed: true }
      : { allowed: false, status: 401, reason: 'the password is wrong' };
  }
  if (access.mode === 'allowlist') {
    const allowed = (access.allowlist ?? []).some((entry) => entry === identity
      || (entry.includes('@') ? entry.toLowerCase() === String(identity).toLowerCase() : false));
    return allowed
      ? { allowed: true }
      : { allowed: false, status: 403, reason: 'this identity is not on the allow list' };
  }
  return { allowed: true };
}

/* ---------------------------------------------------------------- analytics */

/** Record a page view. */
function recordView(id, page = '/') {
  const site = load(id);
  if (!site) throw new Error('site not found');
  site.analytics = site.analytics ?? { views: 0, pages: {}, startedAt: Date.now() };
  site.analytics.views += 1;
  site.analytics.pages[page] = (site.analytics.pages[page] ?? 0) + 1;
  site.analytics.lastViewAt = Date.now();
  save(site);
  return { views: site.analytics.views, pages: site.analytics.pages };
}

/** The analytics summary (WB project-analytics). */
function analyticsSummary(id) {
  const site = load(id);
  if (!site) throw new Error('site not found');
  const analytics = site.analytics ?? { views: 0, pages: {} };
  const pages = Object.entries(analytics.pages ?? {})
    .map(([page, count]) => ({ page, count }))
    .sort((a, b) => b.count - a.count);
  const total = analytics.views || 0;
  return {
    views: total,
    uniquePages: pages.length,
    pages,
    topPage: pages[0]?.page ?? null,
    startedAt: analytics.startedAt ?? null,
    lastViewAt: analytics.lastViewAt ?? null,
    // A page that nobody looked at is the finding worth reporting.
    suggestions: pages.length && pages[0].count === total
      ? ['Every view went to one page — the other pages may not be linked.']
      : [],
  };
}

/* ----------------------------------------------------------- notifications */

/** A notification rule for a published change (WB notifications). */
function addNotification(id, rule = {}) {
  const site = load(id);
  if (!site) throw new Error('site not found');
  const entry = {
    id: `ntf_${crypto.randomBytes(6).toString('base64url')}`,
    event: ['published', 'changed', 'deployed'].includes(rule.event) ? rule.event : 'published',
    channel: ['in-app', 'email', 'webhook'].includes(rule.channel) ? rule.channel : 'in-app',
    target: String(rule.target ?? '').slice(0, 300),
    enabled: rule.enabled !== false,
    createdAt: Date.now(),
  };
  site.notifications = [...(site.notifications ?? []), entry];
  site.updatedAt = Date.now();
  save(site);
  return entry;
}

function removeNotification(id, notificationId) {
  const site = load(id);
  if (!site) throw new Error('site not found');
  const before = (site.notifications ?? []).length;
  site.notifications = (site.notifications ?? []).filter((n) => n.id !== notificationId);
  save(site);
  return { removed: before !== site.notifications.length };
}

/** Fire the notification rules for an event. */
function fireNotifications(id, event = 'published') {
  const site = load(id);
  if (!site) throw new Error('site not found');
  const fired = [];
  for (const rule of site.notifications ?? []) {
    if (!rule.enabled || rule.event !== event) continue;
    fired.push(rule);
    if (rule.channel === 'in-app') {
      try {
        const { noticeService } = require('./noticeService');
        noticeService.push?.({ title: `${site.name}: ${event}`, body: rule.target || '' });
      } catch { /* the notice stack is optional */ }
    }
  }
  return fired;
}

/* --------------------------------------------------------------- schedules */

/** A cron schedule that rebuilds the site (WB schedules). */
function addSchedule(id, { cron, prompt, name } = {}) {
  const site = load(id);
  if (!site) throw new Error('site not found');
  const { validate } = require('./cron');
  const expression = String(cron ?? '').trim();
  validate(expression); // throws on a bad expression
  const entry = {
    id: `sch_${crypto.randomBytes(6).toString('base64url')}`,
    name: String(name ?? 'Rebuild').slice(0, 120),
    cron: expression,
    prompt: String(prompt ?? 'Review the site and apply any improvements you find.').slice(0, 2000),
    enabled: true,
    lastRunAt: null,
    runCount: 0,
    createdAt: Date.now(),
  };
  site.schedules = [...(site.schedules ?? []), entry];
  site.updatedAt = Date.now();
  save(site);
  return entry;
}

function removeSchedule(id, scheduleId) {
  const site = load(id);
  if (!site) throw new Error('site not found');
  const before = (site.schedules ?? []).length;
  site.schedules = (site.schedules ?? []).filter((s) => s.id !== scheduleId);
  save(site);
  return { removed: before !== site.schedules.length };
}

/** The schedules that are due now. */
function dueSchedules(id, now = new Date()) {
  const site = load(id);
  if (!site) return [];
  const { next } = require('./cron');
  return (site.schedules ?? []).filter((schedule) => {
    if (!schedule.enabled) return false;
    const last = schedule.lastRunAt ? new Date(schedule.lastRunAt) : new Date(schedule.createdAt ?? now);
    return next(schedule.cron, last) <= now;
  });
}

/* --------------------------------------------------------------- publishing */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.woff2': 'font/woff2',
};

/**
 * Publish a site locally: a static bundle plus a local server.
 *
 * The docs' publishing target is Google Cloud Run with a managed database;
 * neither is reproducible here, and pretending otherwise would be worse
 * than saying so. What *is* reproducible is the honest local equivalent: the
 * files are the deliverable, the preview server serves them with the access
 * rules enforced, and the DNS records a real deployment would need are
 * generated so the step to a host is one copy-paste away.
 */
async function publish(id, { domain = null, open = false } = {}) {
  const site = load(id);
  if (!site) throw new Error('site not found');

  // A static bundle.
  const dir = path.join(sitesDir(), id, 'exports');
  fs.mkdirSync(dir, { recursive: true });
  const bundlePath = path.join(dir, 'bundle.zip');
  const entries = listFiles(id).map((entry) => {
    const read = readFile(id, entry.path);
    return {
      name: entry.path,
      data: read.binary ? Buffer.from(read.base64, 'base64') : Buffer.from(read.content, 'utf8'),
    };
  });
  fs.writeFileSync(bundlePath, buildZip(entries));

  site.publishedAt = Date.now();
  site.domain = domain ? String(domain).slice(0, 200) : site.domain;
  site.updatedAt = Date.now();
  save(site);

  const server = startPreviewServer(site.id);
  const previewUrl = await server.ready;
  fireNotifications(id, 'published');

  const records = site.domain ? dnsRecords(site.domain) : [];
  return {
    publishedAt: site.publishedAt,
    bundlePath,
    previewUrl,
    domain: site.domain,
    dnsRecords: records,
    files: entries.length,
    note: 'A local static bundle — host the bundle on any static host, or use the preview URL.',
  };
}

/** The DNS records a real deployment would need. */
function dnsRecords(domain) {
  const host = String(domain).replace(/^https?:\/\//, '').replace(/\/$/, '');
  return [
    { type: 'CNAME', name: host, value: 'cname.manus.space', note: 'the target a real deployment points at' },
    { type: 'TXT', name: `_quansiox-verification.${host}`, value: 'quansiox-site-verification', note: 'proves the domain is yours' },
  ];
}

/* ---------------------------------------------------------- preview server */

const servers = new Map();

/**
 * A local static server for one site, with the access rules enforced and
 * the view counter fed. It only ever listens on 127.0.0.1.
 */
function startPreviewServer(id) {
  if (servers.has(id)) return servers.get(id);
  const site = load(id);
  if (!site) throw new Error('site not found');
  const server = http.createServer((req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    const current = load(id);
    if (!current) { res.writeHead(410); res.end('gone'); return; }

    const access = checkAccess(current, {
      token: url.searchParams.get('token'),
      password: url.searchParams.get('password'),
      identity: url.searchParams.get('as'),
    });
    if (!access.allowed) {
      res.writeHead(access.status, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(access.reason);
      return;
    }

    let relative = decodeURIComponent(url.pathname).replace(/^\/+/, '');
    if (!relative || relative.endsWith('/')) relative += 'index.html';
    let absolute = path.join(current.directory, relative);
    if (!absolute.startsWith(current.directory)) { res.writeHead(403); res.end('forbidden'); return; }
    if (!fs.existsSync(absolute) || fs.statSync(absolute).isDirectory()) {
      // A single-page app: unknown paths fall back to the index.
      absolute = path.join(current.directory, 'index.html');
    }
    if (!fs.existsSync(absolute)) { res.writeHead(404); res.end('not found'); return; }
    const extension = path.extname(absolute).toLowerCase();
    const body = fs.readFileSync(absolute);
    res.writeHead(200, {
      'Content-Type': MIME[extension] ?? 'application/octet-stream',
      'Content-Length': body.length,
      'Cache-Control': 'no-store',
    });
    res.end(body);
    try { recordView(id, `/${relative}`); } catch { /* the counter is not worth failing a request over */ }
  });
  const record = { server, url: null, ready: null };
  // The port is only known once the socket is listening, so the caller
  // awaits `ready` rather than reading a URL that is not there yet.
  record.ready = new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      record.url = `http://127.0.0.1:${server.address().port}`;
      resolve(record.url);
    });
  });
  servers.set(id, record);
  return record;
}

function stopPreviewServer(id) {
  const record = servers.get(id);
  if (!record) return { stopped: false };
  try { record.server.close(); } catch { /* ignore */ }
  servers.delete(id);
  return { stopped: true };
}

/** The preview URL for a site, starting the server if needed. */
async function previewUrl(id) {
  const record = startPreviewServer(id);
  const url = await record.ready;
  const site = load(id);
  if (site) { site.previewUrl = url; save(site); }
  return url;
}

module.exports = {
  websiteService: {
    create,
    get,
    list,
    remove,
    listFiles,
    readFile,
    writeFile,
    deleteFile,
    codeControl,
    makeCopy,
    seoAudit,
    applySeo,
    setAccess,
    checkAccess,
    recordView,
    analyticsSummary,
    addNotification,
    removeNotification,
    fireNotifications,
    addSchedule,
    removeSchedule,
    dueSchedules,
    publish,
    dnsRecords,
    startPreviewServer,
    stopPreviewServer,
    previewUrl,
    MIME,
  },
};
