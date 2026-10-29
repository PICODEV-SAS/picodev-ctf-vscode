// A local stand-in for the CTF's author MCP (/mcp/author: JSON-RPC tools/call, stateless, JSON responses), with the
// shapes of the service (picodev-ctf src/ctf/author_mcp.py and authors.py): JSON files as folder_of writes them
// (indent 2, no final newline), draft_put_folder's {revision, with_agent}, bad_path, unknown_template. Every request
// is recorded.
const http = require('http');

const TOKEN = 'ctfa_' + 'Q'.repeat(20) + 'secretpart' + 'Z'.repeat(13);
// the player's tokens (ctfp_ and 43 characters) the claims give, and their sign-in codes
const PLAYER = 'ctfp_' + 'P'.repeat(20) + 'playerpart' + 'Y'.repeat(13);
const PLAYER2 = 'ctfp_' + 'R'.repeat(20) + 'otherplayr' + 'X'.repeat(13);
const CONNECT = { M4N5P6Q7: { token: PLAYER, pseudonym: 'Lucie' }, T8V9W0X1: { token: PLAYER2, pseudonym: 'Mallory' } };
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
    requests: [], // {method, url, headers, body}
    drafts: new Map([
      [66, { id: 66, slug: 'c-evil', state: 'draft', revision: 1, with_agent: true, files: { 'ok.txt': 'y', '../escape.txt': 'x' } }],
      [67, { id: 67, slug: 'c-abs', state: 'draft', revision: 1, with_agent: true, files: { 'ok.txt': 'y', '/tmp/picodev-ctf-abs.txt': 'x' } }],
    ]),
    runPolls: 0,
    players: new Set(), // the player tokens the site knows
    read: new Set(['gpio']), // the courses the player read
    claimable: true, // false: a site without the claim (404 without unknown_code)
    redirect: '', // a route answered by a redirect to /stolen
    lintErrors: [], // what draft_lint answers
    play: [201, { game: 14, agent_code: AGENT_CODE }], // what POST /api/play answers
  };
  const row = (d) => ({ id: d.id, slug: d.slug, state: d.state, revision: d.revision, title: { fr: 'T', en: 'T' }, with_agent: d.with_agent,
    solved_revision: d.solved_revision ?? null });
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
    draft_lint: () => ({ ok: !state.lintErrors.length, errors: state.lintErrors }),
    draft_test_run: () => ({ run: 6, status: 'passed', checks: [{ id: 'flag', ok: true }], events: [{ t: 0, kind: 'boot' }], provenance: null }),
    draft_solve: () => ({ run: 7, status: 'pending', checks: [], events: [], provenance: null }),
    draft_run: (a) => {
      if (++state.runPolls < 3) return { run: a.run, status: 'pending', checks: [], events: [] };
      if (a.run === 7) own(a.id).solved_revision = own(a.id).revision; // a passed solve, as the service's
      return { run: a.run, status: 'passed', checks: [{ id: 'flag', ok: true }], events: [], provenance: 'hello' };
    },
    draft_submit: (a) => {
      own(a.id).state = 'review';
      return { version: 1 };
    },
    review_comments: () => [{ verdict: 'changes', body: 'Say "simulated".\nThanks.', at: '2026-10-27', by: 'picodev' }],
  };

  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      state.requests.push({ method: req.method, url: req.url, headers: req.headers, body });
      const json = (code, value) => {
        res.writeHead(code, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(value));
      };
      if (state.redirect === `${req.method} ${req.url}`) {
        res.writeHead(302, { Location: '/stolen' });
        return res.end();
      }
      if (req.method === 'GET' && req.url === '/api/catalogue') return json(200, CATALOGUE);
      if (req.method === 'GET' && req.url === '/api/courses/gpio') return json(200, COURSE);
      if (req.method === 'GET' && req.url === '/api/challenges/blink-1') return json(200, CHALLENGE);
      if (req.method === 'POST' && req.url === '/api/device/claim') {
        if (!state.claimable) return json(404, { detail: 'Not Found' });
        const c = CONNECT[JSON.parse(body || '{}').code];
        if (!c) return json(404, { detail: 'unknown_code' });
        state.players.add(c.token);
        return json(200, { token: c.token, name: 'VS Code', pseudonym: c.pseudonym, expires_at: '2027-01-25T00:00:00Z' });
      }
      const player = req.headers['x-ctf-player-token'];
      const route = `${req.method} ${req.url}`;
      if (/^(GET \/api\/me\/(courses|games)|POST \/api\/me\/courses\/[a-z0-9-]+\/read|GET \/api\/games\/\d+|POST \/api\/games\/\d+\/(hints\/\d+|close)|POST \/api\/play|DELETE \/api\/device)$/.test(route)) {
        if (state.fail401) return json(401, { detail: 'not_signed_in' });
        if (!state.players.has(player)) return json(401, { detail: 'player_token_required' });
        if (route === 'GET /api/me/courses') return json(200, { read: [...state.read] });
        if (route === 'GET /api/me/games') return json(200, GAMES);
        if (route === 'GET /api/games/12') return json(200, { game: 12, challenge: 'blink-1', open: true, hints: [1], submissions: [] });
        if (route === 'POST /api/games/12/hints/2') return json(200, { text: 'Look at <b>pin 13</b> and [here](command:foo).', cost: 20 });
        if (route === 'POST /api/play') return json(...state.play);
        if (/^POST \/api\/games\/(12|13|14)\/close$/.test(route) || route === 'DELETE /api/device') {
          if (route === 'DELETE /api/device') state.players.delete(player);
          res.writeHead(204);
          return res.end();
        }
        const read = /^POST \/api\/me\/courses\/([a-z0-9-]+)\/read$/.exec(route);
        if (read) return read[1] === 'gpio' || read[1] === 'uart' ? (state.read.add(read[1]), json(200, {})) : json(404, { detail: 'unknown_course' });
        return json(404, { detail: 'unknown_game' });
      }
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

const COURSE = {
  slug: 'gpio', title: { fr: 'Broches', en: 'GPIO' },
  chapters: [
    { id: 'intro', order: 1, en: null, fr: { title: 'Intro', version: 1, body: [
      'Text <img src=https://x.test/track.png> and <b>bold</b>.',
      '',
      '<div onclick="x()">block</div>',
      '',
      '![tracker](https://x.test/y.png) ![pins](img/pins.png) ![up](img/../secret.png) ![abs](/img/a.png)',
      '',
      '[run](command:foo) [code](vscode://x) [file](file:///etc/passwd) [js](javascript:alert(1)) [other](https://x.test/a)',
      '[site](https://ctf.test/cours/gpio) [rel](02-next.md) <https://x.test/auto>',
      '',
      // courses/uart-bavard/01-une-liaison-sans-horloge.fr.md: a callout, as the site draws it
      '> [!takeaway] À retenir',
      '> TX vers RX, RX vers TX, masses reliées. Les deux côtés doivent être configurés avec **le même débit et le même format** avant de communiquer.',
    ].join('\n') } },
    { id: 'more', order: 2, fr: { title: 'Suite', version: 1, body: 'Done.' }, en: { title: 'More', version: 1, body: 'Done.' } },
  ],
};
// GET /api/challenges/blink-1's hints, GET /api/me/games: two games, one of picodev status's challenge
const CHALLENGE = { slug: 'blink-1', hints: [{ n: 1, title: 'Where', cost: 10 }, { n: 2, title: 'Which pin', cost: 20 }] };
const GAMES = [
  { game: 12, challenge: 'blink-1', title: { fr: 'Clignote', en: 'Blink' }, platform: 'nano', hints_used: 1 },
  { game: 13, challenge: 'uart-2', title: { fr: 'UART', en: 'UART' }, platform: 'nano', hints_used: 0 },
];

// the game and sign-in codes the suite uses: never in a file, a setting, a log or a view
const AGENT_CODE = 'H3J4K5M6'; // POST /api/play's agent_code
const CODES = [AGENT_CODE, 'AB12CD34', 'ab12cd34', 'ZX90A7K3', 'zx-90', 'K7M2P9QR', ...Object.keys(CONNECT)];

module.exports = { start, TOKEN, PLAYER, PLAYER2, CODES };
