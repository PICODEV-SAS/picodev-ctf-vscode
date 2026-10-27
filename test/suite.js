// Runs inside the test VS Code: the author's commands against a local mock MCP (started here, in the extension host),
// the player's commands against a fake picodev (test/run.js). The dialogs are stubbed with scripted answers.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vscode = require('vscode');
const mock = require('./mock-mcp');

const TOKEN = mock.TOKEN;
const stubs = [];
function stub(obj, name, fn) {
  const orig = obj[name];
  obj[name] = fn;
  stubs.push(() => (obj[name] = orig));
}
/** Scripted answers per dialog; what each dialog was asked is kept in `asked`. */
const answers = { showInputBox: [], showQuickPick: [], showOpenDialog: [], showWarningMessage: [] };
const asked = { showInputBox: [], showQuickPick: [], showOpenDialog: [], showWarningMessage: [], showErrorMessage: [] };
for (const name of Object.keys(answers)) {
  stub(vscode.window, name, async (...args) => {
    asked[name].push(args);
    const a = answers[name].shift();
    if (name === 'showQuickPick' && a !== undefined) return (await args[0]).find((i) => (i.label ?? i) === a);
    return typeof a === 'function' ? a(...args) : a;
  });
}
stub(vscode.window, 'showErrorMessage', async (...args) => void asked.showErrorMessage.push(args));
asked.showInformationMessage = [];
stub(vscode.window, 'showInformationMessage', async (...args) => void asked.showInformationMessage.push(args));
const opened = [];
stub(vscode.env, 'openExternal', async (uri) => void opened.push(uri.toString(true)) || true);

const exec = (id, ...args) => vscode.commands.executeCommand(id, ...args);
const lastError = () => String(asked.showErrorMessage.at(-1)?.[0] ?? '');

exports.run = async () => {
  const m = await mock.start();
  process.env.PICODEV_CTF_TEST_MCP = m.url; // the extension's transport in a test run; the address stays https
  const ws = vscode.workspace.workspaceFolders[0].uri.fsPath;
  const config = vscode.workspace.getConfiguration('picodevCtf');
  try {
    const api = await vscode.extensions.getExtension('picodev.picodev-ctf').activate();

    // --- http:// refused: nothing asked, nothing sent
    await config.update('url', 'http://ctf.test', vscode.ConfigurationTarget.Global);
    await exec('picodevCtf.setToken');
    assert.strictEqual(asked.showInputBox.length, 0);
    assert.match(lastError(), /https:\/\//);
    await config.update('url', 'https://ctf.test/path', vscode.ConfigurationTarget.Global);
    await exec('picodevCtf.newChallenge');
    assert.strictEqual(asked.showQuickPick.length, 0);
    assert.strictEqual(m.state.requests.length, 0, 'a request left for an address that is not https');

    // --- the token: verified by draft_list, kept in secret storage only
    await config.update('url', 'https://ctf.test', vscode.ConfigurationTarget.Global);
    answers.showInputBox.push(TOKEN);
    await exec('picodevCtf.setToken');
    assert.deepStrictEqual(m.calls().map((c) => c.name), ['draft_list']);
    assert.strictEqual(m.state.requests[0].headers['x-ctf-author-token'], TOKEN);
    assert.strictEqual(m.state.requests[0].headers.authorization, undefined);

    // the MCP server definition carries no token; it gets it when VS Code starts the server
    const [def] = await api.mcp.provideMcpServerDefinitions();
    assert.strictEqual(def.uri.toString(), 'https://ctf.test/mcp/author');
    assert.ok(!JSON.stringify(def).includes(TOKEN), 'a provided definition holds the token');
    assert.strictEqual((await api.mcp.resolveMcpServerDefinition(def)).headers['X-CTF-Author-Token'], TOKEN);

    // --- new challenge: template, folder written, .picodev-draft.json without token
    answers.showQuickPick.push('nano');
    answers.showInputBox.push('c-blink');
    answers.showOpenDialog.push([vscode.Uri.file(ws)]);
    const root = await exec('picodevCtf.newChallenge');
    assert.strictEqual(root, path.join(ws, 'c-blink'));
    const created = m.calls().find((c) => c.name === 'draft_create').arguments;
    assert.deepStrictEqual(created, { slug: 'c-blink', platform: 'nano', template: true });
    assert.match(fs.readFileSync(path.join(root, 'challenge.json'), 'utf8'), /c-blink/);
    assert.ok(fs.existsSync(path.join(root, 'private/target.json')));
    assert.ok(!fs.existsSync(path.join(root, '.git')), 'a git repository was made');
    assert.match(String(asked.showWarningMessage.at(-1)[0]), /hidden part/);
    const meta = JSON.parse(fs.readFileSync(path.join(root, '.picodev-draft.json'), 'utf8'));
    assert.deepStrictEqual(meta, { url: 'https://ctf.test', id: 1, revision: 2, with_agent: false });
    // no template for this platform: the server's unknown_template, nothing written
    answers.showQuickPick.push('esp32');
    answers.showInputBox.push('c-esp');
    answers.showOpenDialog.push([vscode.Uri.file(ws)]);
    await exec('picodevCtf.newChallenge');
    assert.match(lastError(), /No template/);
    assert.ok(!fs.existsSync(path.join(ws, 'c-esp')));

    // --- send: an unchanged folder is not sent again; then only text files, no hidden, build* or links
    await vscode.window.showTextDocument(vscode.Uri.file(path.join(root, 'challenge.json')));
    const puts = () => m.calls().filter((c) => c.name === 'draft_put_folder');
    await exec('picodevCtf.send');
    assert.strictEqual(puts().length, 0, 'an unchanged folder was sent');
    fs.writeFileSync(path.join(root, 'blink/blink.ino'), 'void setup() { /* mine */ }\nvoid loop() {}\n');
    fs.mkdirSync(path.join(root, '.vscode'));
    fs.writeFileSync(path.join(root, '.vscode/x.json'), '{}');
    fs.mkdirSync(path.join(root, 'build'));
    fs.writeFileSync(path.join(root, 'build/a.hex'), ':00');
    fs.writeFileSync(path.join(root, 'build.log'), 'log');
    fs.writeFileSync(path.join(root, 'img.bin'), Buffer.from([0, 1, 2, 255]));
    fs.symlinkSync('/etc/hostname', path.join(root, 'link.txt'));
    await exec('picodevCtf.send');
    assert.strictEqual(puts().length, 1);
    const sent = puts()[0].arguments;
    assert.deepStrictEqual(Object.keys(sent.files).sort(),
      ['blink/blink.ino', 'challenge.json', 'course/01-intro.fr.md', 'course/course.json', 'private/solution/blink.ino', 'private/target.json']);
    assert.strictEqual(sent.with_agent, false);
    assert.strictEqual(sent.revision, 2);
    assert.strictEqual(JSON.parse(fs.readFileSync(path.join(root, '.picodev-draft.json'), 'utf8')).revision, 3);

    // --- stale: the author is asked, overwrite sends again on the server's revision
    const d = m.state.drafts.get(1);
    d.revision = 5; // someone else wrote, with an agent
    d.with_agent = true;
    fs.writeFileSync(path.join(root, 'course/01-intro.fr.md'), '# Intro, mine\n');
    answers.showWarningMessage.push('Overwrite the server');
    const warned = asked.showWarningMessage.length;
    await exec('picodevCtf.send');
    assert.strictEqual(asked.showWarningMessage.length, warned + 1, 'stale did not ask');
    assert.deepStrictEqual(asked.showWarningMessage.at(-1).slice(2), ['Overwrite the server', 'Reload from the server']);
    assert.strictEqual(puts().at(-1).arguments.revision, 5);
    assert.strictEqual(d.revision, 6);
    assert.strictEqual(d.files['course/01-intro.fr.md'], '# Intro, mine\n');
    assert.strictEqual(JSON.parse(fs.readFileSync(path.join(root, '.picodev-draft.json'), 'utf8')).with_agent, true);
    // reload: the server's folder replaces the local one, nothing is sent
    d.revision = 9;
    d.files = { ...d.files, 'course/01-intro.fr.md': '# Intro, theirs\n' };
    delete d.files['blink/blink.ino'];
    fs.writeFileSync(path.join(root, 'course/01-intro.fr.md'), '# Intro, mine again\n');
    answers.showWarningMessage.push('Reload from the server');
    const before = puts().length;
    await exec('picodevCtf.send');
    assert.strictEqual(puts().length, before);
    assert.strictEqual(fs.readFileSync(path.join(root, 'course/01-intro.fr.md'), 'utf8'), '# Intro, theirs\n');
    assert.ok(!fs.existsSync(path.join(root, 'blink/blink.ino')), 'a file the server no longer has stayed');
    assert.strictEqual(JSON.parse(fs.readFileSync(path.join(root, '.picodev-draft.json'), 'utf8')).revision, 9);
    // no answer: nothing sent
    d.revision = 10;
    await exec('picodevCtf.send');
    assert.strictEqual(puts().length, before);
    // a link planted in the folder, pointing out of the draft: a reload refuses it, nothing is created outside
    const outside = fs.mkdtempSync(path.join(path.dirname(ws), 'outside-'));
    fs.rmSync(path.join(root, 'blink'), { recursive: true, force: true });
    fs.symlinkSync(outside, path.join(root, 'blink'));
    d.files = { ...d.files, 'blink/blink.ino': 'x', 'blink/deep/more.ino': 'y', 'course/01-intro.fr.md': '# changed\n' };
    answers.showWarningMessage.push('Reload from the server');
    await exec('picodevCtf.send');
    assert.match(lastError(), /outside the draft folder/);
    assert.deepStrictEqual(fs.readdirSync(outside), [], 'written through a link');
    assert.strictEqual(fs.readFileSync(path.join(root, 'course/01-intro.fr.md'), 'utf8'), '# Intro, theirs\n', 'written before the check');
    fs.unlinkSync(path.join(root, 'blink'));
    d.files = { ...d.files, 'course/01-intro.fr.md': '# Intro, theirs\n' };
    delete d.files['blink/blink.ino'];
    delete d.files['blink/deep/more.ino'];
    // a file the service has no place for: its bad_path, shown
    d.revision = 9;
    fs.writeFileSync(path.join(root, 'course/notes.txt'), 'n');
    await exec('picodevCtf.send');
    assert.match(lastError(), /no place in a draft/);
    assert.strictEqual(puts().at(-1).arguments.with_agent, true, 'with_agent went back to false');
    fs.rmSync(path.join(root, 'course/notes.txt'));

    // --- check, try, solve (pending, then draft_run every poll), submit, comments
    await exec('picodevCtf.check');
    assert.strictEqual(m.calls().at(-1).name, 'draft_lint');
    await exec('picodevCtf.try');
    assert.strictEqual(m.calls().at(-1).name, 'draft_test_run');
    const solve = await exec('picodevCtf.solve');
    const names = m.calls().map((c) => c.name);
    assert.deepStrictEqual(names.slice(names.lastIndexOf('draft_solve')), ['draft_solve', 'draft_run', 'draft_run', 'draft_run']);
    assert.ok(m.calls().filter((c) => c.name === 'draft_run').every((c) => c.arguments.run === 7 && c.arguments.id === 1));
    assert.strictEqual(solve.status, 'passed');
    assert.strictEqual((await exec('picodevCtf.submit')).version, 1);
    const n = m.calls().length;
    assert.strictEqual((await exec('picodevCtf.comments')).length, 1);
    assert.deepStrictEqual(m.calls().slice(n).map((c) => c.name), ['review_comments'], 'comments wrote the draft');
    assert.strictEqual(puts().length, before + 1, 'an unchanged folder was sent before check/try/solve/submit');

    // --- draft_folder paths: ../ and absolute refused, nothing written at all
    for (const [slug, outside] of [['c-evil', path.join(ws, 'escape.txt')], ['c-abs', '/tmp/picodev-ctf-abs.txt']]) {
      answers.showQuickPick.push(slug);
      answers.showOpenDialog.push([vscode.Uri.file(ws)]);
      await exec('picodevCtf.openDraft');
      assert.match(lastError(), /outside the draft folder/);
      assert.ok(!fs.existsSync(outside), `${outside} written`);
      assert.ok(!fs.existsSync(path.join(ws, slug, 'ok.txt')), 'files written before the paths were checked');
    }

    // --- the token: never in the workspace, the settings, the log or a request's address or body
    const all = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory() ? all(path.join(dir, e.name)) : e.isFile() ? [path.join(dir, e.name)] : []);
    assert.deepStrictEqual(all(ws).filter((f) => fs.readFileSync(f).includes(TOKEN)), []);
    assert.ok(!JSON.stringify(config.inspect('url')).includes(TOKEN));
    assert.ok(!api.logText().includes(TOKEN));
    assert.ok(api.logText().includes('Check: no error.'));
    assert.ok(m.state.requests.every((r) => !r.url.includes(TOKEN) && !r.body.includes(TOKEN)));

    // --- player: picodev by execFile, the login code validated first
    const fake = () => (fs.existsSync(process.env.PICODEV_FAKE_LOG) ? fs.readFileSync(process.env.PICODEV_FAKE_LOG, 'utf8') : '');
    for (const bad of ['AB;rm -rf', '$(id)ABC', 'ABCDEFGI', 'AB12CD3', '']) {
      await exec('picodevCtf.login', bad);
      assert.match(lastError(), /8 characters/, bad);
    }
    assert.ok(!fake().includes('login'), 'picodev ran for a refused code');
    assert.strictEqual(await exec('picodevCtf.login', 'ab12cd34'), 0);
    assert.match(fake(), /^login\n--url\nhttps:\/\/ctf\.test\nAB12CD34\n--$/m);
    assert.strictEqual(await exec('picodevCtf.playerSend'), 0);
    assert.match(fake(), /^send\n--$/m);
    await exec('picodevCtf.status');
    assert.match(api.statusText(), /^\$\(target\) blink-1 · 1\/3 · 1[01] min$/);
    await exec('picodevCtf.openStarter', 'esp32');
    assert.deepStrictEqual(opened, ['vscode://ms-vscode-remote.remote-containers/cloneInVolume?url=https://github.com/PICODEV-SAS/picodev-starter-esp32']);
    await exec('picodevCtf.openStarter', 'x&y');
    assert.strictEqual(opened.length, 1);

    // --- the views, built from picodev status; a single highlighted "Next" line
    const fakeSet = (cmd, files = {}) => {
      for (const ext of ['out', 'err', 'exit']) {
        const f = path.join(process.env.PICODEV_FAKE_DIR, `${cmd}.${ext}`);
        if (files[ext] === undefined) fs.rmSync(f, { force: true });
        else fs.writeFileSync(f, String(files[ext]));
      }
    };
    const labelOf = (i) => (typeof i.label === 'string' ? i.label : i.label.label);
    const view = async (id) => (await api.views[id].getChildren()).map(labelOf);
    const infos = () => asked.showInformationMessage.map((a) => String(a[0]));
    const nowS = () => Math.floor(Date.now() / 1000);
    let game = await view('game');
    assert.deepStrictEqual(game.slice(0, 3), ['Next: hand in the flag on the game screen', 'Challenge: blink-1', 'Level 1/3']);
    assert.match(game[3], /^1[01] min left$/);
    const [next] = await api.views.game.getChildren();
    assert.deepStrictEqual(next.label.highlights, [[0, next.label.label.length]]);
    const actions = await view('actions');
    assert.ok(actions.includes('Watch the game') && actions.includes('Board console') && !actions.includes('Join a game'), actions.join());
    assert.strictEqual(actions.filter((l) => l.startsWith('Next:')).length, 1);
    const author = await view('author');
    assert.strictEqual(author[0], 'Next: check the draft');
    assert.strictEqual(author.at(-1), 'picodev.fr');

    // --- build: the compiler's lines in the Problems panel, mapped to the workspace; cleared by a successful build
    fs.mkdirSync(path.join(ws, 'src'), { recursive: true });
    const main = vscode.Uri.file(path.join(ws, 'src/main.c'));
    fs.writeFileSync(main.fsPath, 'int main(void) { return x; }\n');
    fakeSet('build', {
      out: `${ws}/src/main.c:1:25: error: 'x' undeclared (first use in this function)\n`
        + '/tmp/build-copy/src/main.c:1:1: \x1b[35mwarning: \x1b[0munused thing\n'
        + "/opt/toolchain/include/stdio.h:3:1: error: not the player's\n",
      exit: 1,
    });
    assert.strictEqual(await exec('picodevCtf.build'), 1);
    assert.deepStrictEqual(vscode.languages.getDiagnostics(main).map((d) => [d.severity, d.range.start.line, d.range.start.character, d.message]),
      [[vscode.DiagnosticSeverity.Error, 0, 24, "'x' undeclared (first use in this function)"], [vscode.DiagnosticSeverity.Warning, 0, 0, 'unused thing']]);
    assert.ok(!vscode.languages.getDiagnostics().some(([u, l]) => l.some((d) => d.source === 'picodev') && !u.fsPath.startsWith(ws)),
      'a toolchain file in Problems');
    assert.match(lastError(), /picodev build: 1 error\(s\)/);
    assert.strictEqual((await view('actions'))[0], 'Next: fix the errors (Problems panel)');
    fakeSet('build');
    assert.strictEqual(await exec('picodevCtf.build'), 0);
    assert.deepStrictEqual(vscode.languages.getDiagnostics(main), []);
    assert.match(fake(), /^build\n--$/m);

    // --- notifications: level reached, 5 minutes left (once), game over (exit 4) and the status reset
    fakeSet('status', { out: JSON.stringify({ challenge: 'blink-1', expires_at: nowS() + 200, level: 1, levels: 3 }) });
    await exec('picodevCtf.status');
    assert.ok(infos().includes('Level 2/3 reached.'), infos().join('|'));
    assert.ok(infos().some((m) => m.startsWith('5 minutes left')));
    const notified = infos().length;
    await exec('picodevCtf.status');
    assert.strictEqual(infos().length, notified, 'warned twice');
    fakeSet('status', { exit: 4 });
    await exec('picodevCtf.status');
    assert.strictEqual(infos().at(-1), 'The game is over.');
    assert.strictEqual(api.statusText(), '$(target) no game');
    assert.deepStrictEqual(await view('game'), []);
    assert.deepStrictEqual((await view('actions')).slice(0, 3), ['Next: join a game', 'Join a game', 'Start a game']);
    fakeSet('status');
    await exec('picodevCtf.status');
    assert.match(api.statusText(), /^\$\(target\) blink-1 · /);

    // --- game screen, hint and abandon (a modal says the game screen opens), board console (picodev itself)
    await exec('picodevCtf.gameScreen');
    assert.strictEqual(opened.at(-1), 'https://ctf.test/defis/blink-1');
    answers.showWarningMessage.push('Open the game screen');
    await exec('picodevCtf.hint');
    assert.strictEqual(asked.showWarningMessage.at(-1)[1].modal, true);
    assert.match(asked.showWarningMessage.at(-1)[0], /cost in points/);
    assert.strictEqual(opened.length, 3);
    await exec('picodevCtf.abandon'); // no answer: nothing opens
    assert.match(asked.showWarningMessage.at(-1)[0], /abandoned on the game screen/);
    assert.strictEqual(opened.length, 3);
    await exec('picodevCtf.console');
    const term = vscode.window.terminals.find((x) => x.name === 'Board console');
    assert.deepStrictEqual([term.creationOptions.shellPath, term.creationOptions.shellArgs], ['picodev', ['events', '--follow']]);
    term.dispose();

    // --- Voir la partie: only the link's /regarder#<session>.<viewer>, framed from picodevCtf.url's origin
    fakeSet('watch', { out: 'https://ctf.test/regarder#sess_1.view-2\n' });
    assert.strictEqual(await exec('picodevCtf.watch'), '/regarder#sess_1.view-2');
    const html = api.watchHtml();
    assert.match(html, /content="default-src 'none'; frame-src https:\/\/ctf\.test; style-src 'unsafe-inline'"/);
    assert.match(html, /<iframe src="https:\/\/ctf\.test\/regarder#sess_1\.view-2" sandbox="allow-scripts allow-same-origin"/);
    assert.doesNotMatch(html, /<script/i);
    for (const bad of ['https://evil.test/regarder#a.b', 'http://ctf.test/regarder#a.b', '/regarder#a', '/regarder#a.b?x=1',
      'https://ctf.test/regarder?x#a.b', '/regarder#a.b"><script>', '/other#a.b', 'javascript:alert(1)//regarder#a.b', '']) {
      fakeSet('watch', { out: bad });
      assert.strictEqual(await exec('picodevCtf.watch'), undefined, bad);
      assert.match(lastError(), /no spectator link/, bad);
    }
    fakeSet('watch', { err: "picodev: error: argument command: invalid choice: 'watch'", exit: 2 });
    await exec('picodevCtf.watch');
    assert.match(infos().at(-1), /has no watch command/);
    fakeSet('watch');

    // --- Lancer une partie: the public catalogue (no cookie, no token), a challenge opens with poste=machine&retour=vscode
    answers.showQuickPick.push('Blink');
    assert.strictEqual(await exec('picodevCtf.launch'), 'https://ctf.test/defis/blink-1?poste=machine&retour=vscode');
    const req = m.state.requests.at(-1);
    assert.strictEqual(req.url, '/api/catalogue');
    assert.ok(!req.headers.cookie && !req.headers.authorization && !req.headers['x-ctf-author-token']);
    const [items, opts] = asked.showQuickPick.at(-1);
    assert.deepStrictEqual((await items).map((i) => [i.label, i.description]),
      [['Blink', 'challenge · nano · uart · 100 pts'], ['GPIO', 'course · nano · 12 min']]);
    assert.ok(opts.matchOnDescription && opts.matchOnDetail);
    assert.strictEqual(opened.at(-1), 'https://ctf.test/defis/blink-1?poste=machine&retour=vscode');
    answers.showQuickPick.push('GPIO');
    await exec('picodevCtf.launch');
    assert.strictEqual(opened.at(-1), 'https://ctf.test/cours/gpio');

    // --- vscode://picodev.picodev-ctf/join?code=…: the code only, normalised; any other parameter ignored
    const logins = () => (fake().match(/^login$/gm) ?? []).length;
    const before4 = logins();
    for (const q of ['', 'code=', 'code=ABCDEFGI', 'code=AB12CD3', 'code=AB12CD34X', 'url=https%3A%2F%2Fevil.test', 'code=AB12%3BCD34']) {
      await api.handleUri(vscode.Uri.parse(`vscode://picodev.picodev-ctf/join?${q}`));
      assert.match(lastError(), /8 characters/, q);
    }
    await api.handleUri(vscode.Uri.parse('vscode://picodev.picodev-ctf/other?code=AB12CD34'));
    assert.strictEqual(logins(), before4, 'picodev ran for a refused link');
    await api.handleUri(vscode.Uri.parse('vscode://picodev.picodev-ctf/join?code=zx-90%20a7k3&url=https%3A%2F%2Fevil.test&next=x'));
    assert.match(fake(), /^login\n--url\nhttps:\/\/ctf\.test\nZX90A7K3\n--$/m);
    assert.ok(!fake().includes('evil'));

    // without picodev: the code waits in memory, the views offer the starter project, then "Join"
    api.noPicodev();
    await api.handleUri(vscode.Uri.parse('vscode://picodev.picodev-ctf/join?code=K7M2P9QR'));
    assert.match(infos().at(-1), /kept 15 minutes/);
    assert.ok(!fake().includes('K7M2P9QR'));
    assert.strictEqual((await view('actions'))[0], 'Next: open the starter project in its container');
    await exec('picodevCtf.joinPending');
    assert.match(fake(), /^login\n--url\nhttps:\/\/ctf\.test\nK7M2P9QR\n--$/m);
    assert.strictEqual((await view('actions'))[0], 'Next: start a game', 'the code stayed after joining');

    // --- no token and no game code in a view, the log or the settings
    const shown = (await Promise.all(Object.keys(api.views).map(view))).flat().join('\n');
    for (const s of [TOKEN, ...mock.CODES]) {
      assert.ok(!shown.includes(s) && !api.logText().includes(s) && !JSON.stringify(config.inspect('url')).includes(s), s);
    }
    assert.ok(!api.logText().includes('sess_1'), 'the spectator link was logged');
    console.log('suite: ok');
  } finally {
    await config.update('url', undefined, vscode.ConfigurationTarget.Global);
    m.close();
    stubs.forEach((undo) => undo());
  }
};
