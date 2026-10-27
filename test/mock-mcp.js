// A local stand-in for the CTF's author MCP (/mcp/author: JSON-RPC tools/call, stateless, JSON responses), with the
// shapes of the service (picodev-ctf src/ctf/author_mcp.py and authors.py): JSON files as folder_of writes them
// (indent 2, no final newline), draft_put_folder's {revision, with_agent}, bad_path, unknown_template. Every request
// is recorded.
const http = require('http');

const TOKEN = 'ctfa_' + 'Q'.repeat(20) + 'secretpart' + 'Z'.repeat(13);
const TEMPLATE = {
  'challenge.json': '{\n  "slug": "SLUG",\n  "platform": "nano"\n}',
  'blink/blink.ino': 'void setup() {}\nvoid loop() {}\n',
  'private/target.json': '{\n  "flag": "{flag}"\n}',
  'private/solution/blink.ino': 'void setup() {}\n',
  'course/course.json': '{}',
  'course/01-intro.fr.md': '# Intro\n',
};

async function start() {
  const state = {
    requests: [], // {url, headers, body}
    drafts: new Map([
      [66, { id: 66, slug: 'c-evil', state: 'draft', revision: 1, with_agent: true, files: { 'ok.txt': 'y', '../escape.txt': 'x' } }],
      [67, { id: 67, slug: 'c-abs', state: 'draft', revision: 1, with_agent: true, files: { 'ok.txt': 'y', '/tmp/picodev-ctf-abs.txt': 'x' } }],
    ]),
    runPolls: 0,
  };
  const row = (d) => ({ id: d.id, slug: d.slug, state: d.state, revision: d.revision, title: { fr: 'T', en: 'T' }, with_agent: d.with_agent });
  const own = (id) => {
    const d = state.drafts.get(id);
    if (!d) throw new Error('unknown_draft');
    return d;
  };
  const tools = {
    draft_list: () => [...state.drafts.values()].map(row),
    draft_create: (a) => {
      if (a.template && a.platform !== 'nano') throw new Error('unknown_template');
      const id = 1 + Math.max(0, ...[...state.drafts.keys()].filter((k) => k < 60));
      const files = Object.fromEntries(Object.entries(TEMPLATE).map(([k, v]) => [k, v.replace('SLUG', a.slug)]));
      // a template: written once after the creation, and not an agent's text
      const d = { id, slug: a.slug, state: 'draft', revision: 2, with_agent: false, files, platform: a.platform };
      state.drafts.set(id, d);
      return { ...row(d), public: {} };
    },
    draft_folder: (a) => ({ files: own(a.id).files, revision: own(a.id).revision }),
    draft_put_folder: (a) => {
      const d = own(a.id);
      for (const rel of Object.keys(a.files)) {
        const segs = rel.split('/');
        const chapter = /^course\/\d{2}-[a-z0-9-]+\.(fr|en)\.md$/.test(rel) || rel === 'course/course.json';
        if (rel.startsWith('/') || segs.some((x) => ['', '.', '..'].includes(x)) || (rel.startsWith('course/') && !chapter)) {
          throw new Error('bad_path');
        }
      }
      if (a.revision !== d.revision) throw new Error('stale');
      d.files = a.files;
      d.revision++;
      d.with_agent = d.with_agent || a.with_agent;
      return { revision: d.revision, with_agent: d.with_agent };
    },
    draft_lint: () => ({ ok: true, errors: [] }),
    draft_test_run: () => ({ run: 6, status: 'passed', checks: [{ id: 'flag', ok: true }], events: [{ t: 0, kind: 'boot' }], provenance: null }),
    draft_solve: () => ({ run: 7, status: 'pending', checks: [], events: [], provenance: null }),
    draft_run: (a) => (++state.runPolls < 3 ? { run: a.run, status: 'pending', checks: [], events: [] }
      : { run: a.run, status: 'passed', checks: [{ id: 'flag', ok: true }], events: [], provenance: 'hello' }),
    draft_submit: () => ({ version: 1 }),
    review_comments: () => [{ verdict: 'changes', body: 'Say "simulated".\nThanks.', at: '2026-10-27', by: 'picodev' }],
  };

  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      state.requests.push({ url: req.url, headers: req.headers, body });
      const json = (code, value) => {
        res.writeHead(code, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(value));
      };
      if (req.method === 'GET' && req.url === '/api/catalogue') return json(200, CATALOGUE);
      if (req.method !== 'POST' || req.url !== '/mcp/author') return json(404, {});
      if (req.headers['x-ctf-author-token'] !== TOKEN) return json(401, { detail: 'author_token_required' });
      const msg = JSON.parse(body);
      const { name, arguments: args } = msg.params;
      let result;
      try {
        const out = tools[name](args ?? {});
        result = { content: [{ type: 'text', text: JSON.stringify(out) }], structuredContent: Array.isArray(out) ? { result: out } : out, isError: false };
      } catch (e) {
        result = { content: [{ type: 'text', text: `Error executing tool ${name}: ${e.message}` }], isError: true };
      }
      json(200, { jsonrpc: '2.0', id: msg.id, result });
    });
  });
  await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    state,
    calls: () => state.requests.map((r) => { try { return JSON.parse(r.body).params; } catch { return {}; } }),
    close: () => server.close(),
  };
}

// GET /api/catalogue as the service gives it (cards of content.CARD_FIELDS, CatalogueCourse), with one card whose slug
// would leave /defis/
const CATALOGUE = {
  challenges: [
    { slug: 'blink-1', title: { fr: 'Clignote', en: 'Blink' }, summary: { fr: 'Une LED', en: 'A LED' }, platform: 'nano',
      theme: 'uart', execution: 'simulated', access: 'free', points: 100, season: null },
    { slug: '../admin', title: { fr: 'Mal', en: 'Evil' }, summary: { fr: '', en: '' }, platform: 'nano', points: 1 },
  ],
  courses: [
    { slug: 'gpio', title: { fr: 'Broches', en: 'GPIO' }, summary: { fr: 'Les broches', en: 'Pins' }, reading_minutes: 12,
      challenge: 'blink-1', chapters: 3, platforms: ['nano'] },
  ],
};

// the game codes the suite uses: never in a file, a setting, a log or a view
const CODES = ['AB12CD34', 'ab12cd34', 'ZX90A7K3', 'zx-90', 'K7M2P9QR'];

module.exports = { start, TOKEN, CODES };
