import * as vscode from 'vscode';
import * as fs from 'fs/promises';
import * as path from 'path';
import { CtfError, DEFAULT_URL, callTool, checkUrl } from './mcp';
import { META, Meta, SLUG, readFolder, readMeta, sameFolder, sections, writeFolder, writeMeta } from './draft';
import { existsSync } from 'fs';
import {
  FAMILIES, Game, Ran, loginArgs, mapPath, minutesLeft, normCode, parseDiagnostics, picodev, readStatus, slugOf, starterLink,
  statusText, watchHtml, watchPath,
} from './player';

const t = vscode.l10n.t;
const PLATFORMS = ['nano', 'nrf52', 'esp32', 'stm32']; // the families' templates, templates/draft-<platform>/
const TOKEN = /^ctfa_[A-Za-z0-9_-]{20,59}$/;
const MAX_POLLS = 120; // ten minutes of draft_run at one every 5 s
const STATUS_MS = 60_000;

let secrets: vscode.SecretStorage;
let out: vscode.OutputChannel;
let status: vscode.StatusBarItem;
let testing = false;
// the integration test's mock server (started by the suite), read in a test run only
const transport = () => (testing ? process.env.PICODEV_CTF_TEST_MCP : undefined);
let pollMs = 5000;
let logged = ''; // what the output channel got, for the test only
let mcpChanged: vscode.EventEmitter<void>;
let drafts: any[] | undefined; // draft_list, read again after an author command
// shortcut: this window's last check and passed try per draft id, at the revision they ran on; lost on reload, which
// the server would fix by keeping them (draft_list has solved_revision only)
const lints = new Map<number, { revision: number; errors: string[] }>();
const tried = new Map<number, number>();

const tokenKey = (origin: string) => `token:${origin}`;
const siteKey = (origin: string) => `site:${origin}`;

function log(line: string) {
  out.appendLine(line);
  if (testing) logged += line + '\n';
}

/** The CTF's address from picodevCtf.url: https only. */
function settingUrl(): string {
  return checkUrl(vscode.workspace.getConfiguration('picodevCtf').get<string>('url') || DEFAULT_URL);
}

async function call(origin: string, name: string, args: object): Promise<any> {
  const token = await secrets.get(tokenKey(origin));
  if (!token) throw new CtfError('no_token', origin);
  return callTool(origin, name, args, { token, site: await secrets.get(siteKey(origin)) }, transport());
}

const MESSAGES: Record<string, () => string> = {
  bad_url: () => t('The CTF address must start with https:// (setting picodevCtf.url).'),
  no_token: () => t('No author token for this address: run "Picodev CTF: Set the author token".'),
  author_token_required: () => t('The author token was refused (revoked, or the profile lost the author role).'),
  site_auth_required: () => t('This site asks for its password: run "Picodev CTF: Set the author token" again.'),
  unsafe_path: () => t('The server sent a path outside the draft folder; nothing was written.'),
  bad_path: () => t('A file of the folder has no place in a draft (challenge.json, the programs, private/, course/course.json and its chapters).'),
  unknown_template: () => t('No template for this platform yet.'),
  no_draft: () => t('No draft folder here (no valid .picodev-draft.json).'),
  bad_code: () => t('A game code is 8 characters (digits and letters, without I, L, O, U).'),
  too_large: () => t('The draft is too large.'),
  network: () => t('The CTF cannot be reached.'),
  no_game: () => t('No game here: join one first.'),
  bad_watch: () => t('picodev watch gave no spectator link of this address.'),
  site_password: () => t('The site\'s password was refused.'),
};

function fail(e: unknown) {
  if (e instanceof CtfError && e.code === 'cancelled') return;
  const code = e instanceof CtfError ? e.code : 'error';
  const text = MESSAGES[code]?.() ?? (e instanceof Error ? e.message : String(e));
  // a refused game code may be a real one mistyped: never in the log
  log(code === 'bad_code' ? `! ${code}` : `! ${code}: ${e instanceof Error ? e.message : String(e)}`);
  void vscode.window.showErrorMessage(t('Picodev CTF: {0}', text));
}

const guarded = (run: (...args: any[]) => Promise<unknown>) => async (...args: any[]) => {
  try {
    return await run(...args);
  } catch (e) {
    fail(e);
  }
};

function command(id: string, run: (...args: any[]) => Promise<unknown>): vscode.Disposable {
  return vscode.commands.registerCommand(id, guarded(run));
}

/** The staging site's user:password (Caddy), asked when the site answers 401 Basic. */
async function askSite(origin: string): Promise<string | undefined> {
  return (await vscode.window.showInputBox({
    title: t('Password of {0}', origin),
    prompt: t('This site is closed by a password: user:password.'),
    password: true,
    ignoreFocusOut: true,
    validateInput: (v) => (/^[^:\s]+:\S+$/.test(v) ? undefined : t('user:password')),
  }))?.trim();
}

// --- Author ---------------------------------------------------------------------------------------------------------

async function setToken(): Promise<void> {
  const origin = settingUrl();
  const token = (await vscode.window.showInputBox({
    title: t('Author token for {0}', origin),
    prompt: t('Paste the ctfa_… token made in your profile (shown once). It is kept in VS Code\'s secret storage.'),
    password: true,
    ignoreFocusOut: true,
    validateInput: (v) => (TOKEN.test(v.trim()) ? undefined : t('An author token starts with ctfa_.')),
  }))?.trim();
  if (!token) return;
  let site = await secrets.get(siteKey(origin));
  let drafts: any[];
  for (;;) {
    try {
      drafts = await callTool(origin, 'draft_list', {}, { token, site }, transport());
      break;
    } catch (e) {
      if (!(e instanceof CtfError && e.code === 'site_auth_required')) throw e;
      site = await askSite(origin);
      if (!site) return;
    }
  }
  await secrets.store(tokenKey(origin), token);
  if (site) await secrets.store(siteKey(origin), site);
  mcpChanged.fire();
  log(t('Author token verified for {0}: {1} draft(s).', origin, drafts.length));
  void vscode.window.showInformationMessage(t('Author token verified and kept for {0}.', origin));
}

async function forgetToken(): Promise<void> {
  const origin = settingUrl();
  await secrets.delete(tokenKey(origin));
  await secrets.delete(siteKey(origin));
  mcpChanged.fire();
  void vscode.window.showInformationMessage(t('Author token forgotten for {0}.', origin));
}

async function pickParent(): Promise<string | undefined> {
  const picked = await vscode.window.showOpenDialog({
    canSelectFolders: true, canSelectFiles: false, canSelectMany: false,
    defaultUri: vscode.workspace.workspaceFolders?.[0]?.uri,
    openLabel: t('Put the draft here'),
  });
  return picked?.[0]?.fsPath;
}

/** Writes a draft's folder in <parent>/<slug>/, which must not exist yet or be empty. */
async function materialize(origin: string, d: { id: number; slug: string; with_agent?: boolean }, parent: string): Promise<string> {
  if (!SLUG.test(d.slug)) throw new CtfError('unsafe_path', d.slug);
  const root = path.join(parent, d.slug);
  if ((await fs.readdir(root).catch(() => [])).length) throw new Error(t('{0} already exists and is not empty.', root));
  const f = await call(origin, 'draft_folder', { id: d.id });
  await writeFolder(root, f?.files);
  await writeMeta(root, { url: origin, id: d.id, revision: f.revision, with_agent: d.with_agent === true });
  log(t('Draft {0} (revision {1}) written to {2}.', d.slug, f.revision, root));
  const open = t('Open the folder');
  // the hidden part is plain files on the author's disk: say it, and never make a git repository of it
  const r = await vscode.window.showWarningMessage(
    t('The hidden part of {0} (target, flag, reference solution, under private/) is now on your disk. Keep this folder out of any shared or public repository.', d.slug),
    open);
  if (r === open) await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(root), { forceNewWindow: true });
  return root;
}

async function newChallenge(): Promise<string | undefined> {
  const origin = settingUrl();
  const platform = await vscode.window.showQuickPick(PLATFORMS, { title: t('Platform of the challenge') });
  if (!platform) return;
  const slug = (await vscode.window.showInputBox({
    title: t('Name of the challenge'),
    prompt: t('c-<name>: lowercase letters, digits and dashes, 40 characters at most.'),
    value: 'c-',
    validateInput: (v) => (SLUG.test(v) && v.length <= 40 ? undefined : t('c-<name>: lowercase letters, digits and dashes.')),
  }))?.trim();
  if (!slug) return;
  const parent = await pickParent();
  if (!parent) return;
  const d = await call(origin, 'draft_create', { slug, platform, template: true });
  return materialize(origin, d, parent); // with_agent false: Picodev's template, not an agent's text
}

const titleOf = (x: any) => (typeof x === 'string' ? x : x?.[vscode.env.language.startsWith('fr') ? 'fr' : 'en'] ?? x?.fr ?? '');

/** A draft of the Author view's list (`d`), else picked from draft_list. */
async function openDraft(d?: { id: number; slug: string; with_agent?: boolean }): Promise<string | undefined> {
  const origin = settingUrl();
  if (!d) {
    const list: any[] = await call(origin, 'draft_list', {});
    if (!list.length) {
      void vscode.window.showInformationMessage(t('No draft yet: "Picodev CTF: New challenge" makes one.'));
      return;
    }
    d = (await vscode.window.showQuickPick(
      list.map((d) => ({ label: String(d.slug), description: `${d.state} · r${d.revision}`, detail: String(titleOf(d.title)), d })),
      { title: t('Draft to open') }))?.d;
    if (!d) return;
  }
  const parent = await pickParent();
  if (!parent) return;
  return materialize(origin, d, parent);
}

/** The draft folder of the active editor (nearest .picodev-draft.json above it), else the workspace's. */
async function findDraft(): Promise<string> {
  const doc = vscode.window.activeTextEditor?.document.uri;
  if (doc?.scheme === 'file') {
    for (let dir = path.dirname(doc.fsPath); ; dir = path.dirname(dir)) {
      if (await fs.stat(path.join(dir, META)).then(() => true, () => false)) return dir;
      if (path.dirname(dir) === dir) break;
    }
  }
  const found = await vscode.workspace.findFiles(`**/${META}`, '**/node_modules/**', 50);
  if (found.length === 1) return path.dirname(found[0].fsPath);
  if (!found.length) throw new CtfError('no_draft');
  const pick = await vscode.window.showQuickPick(found.map((u) => ({ label: vscode.workspace.asRelativePath(path.dirname(u.fsPath)), u })),
    { title: t('Which draft?') });
  if (!pick) throw new CtfError('cancelled');
  return path.dirname(pick.u.fsPath);
}

/**
 * Sends the folder (draft_put_folder) unless the server already has it: an unchanged send would make a new revision
 * and undo draft_solve's. On stale, the author overwrites the server's draft or reloads it (which stops the action).
 */
async function send(): Promise<{ root: string; meta: Meta }> {
  const root = await findDraft();
  const meta = await readMeta(root);
  const { files, skipped } = await readFolder(root);
  if (skipped.length) log(t('Not sent (binary or not a regular file): {0}', skipped.join(', ')));
  let server = await call(meta.url, 'draft_folder', { id: meta.id });
  if (server.revision === meta.revision && sameFolder(files, server.files ?? {})) return { root, meta };
  for (let attempt = 0; ; attempt++) {
    try {
      if (server.revision !== meta.revision) throw new CtfError('stale');
      const r = await call(meta.url, 'draft_put_folder', { id: meta.id, revision: meta.revision, files, with_agent: meta.with_agent });
      if (!Number.isSafeInteger(r?.revision) || typeof r?.with_agent !== 'boolean') throw new CtfError('bad_response');
      meta.revision = r.revision;
      meta.with_agent = r.with_agent; // the server's: once true, it stays true
      await writeMeta(root, meta);
      log(t('Sent: revision {0}.', meta.revision));
      return { root, meta };
    } catch (e) {
      if (!(e instanceof CtfError && e.code === 'stale') || attempt > 1) throw e;
      const overwrite = t('Overwrite the server');
      const reload = t('Reload from the server');
      const choice = await vscode.window.showWarningMessage(
        t('The draft changed on the server since your last send or reload.'),
        { modal: true, detail: t('Overwrite: your folder replaces it. Reload: the server\'s draft replaces your folder (your local changes are lost).') },
        overwrite, reload);
      server = await call(meta.url, 'draft_folder', { id: meta.id }); // the server's draft as it is now
      if (choice === overwrite) {
        meta.revision = server.revision;
      } else if (choice === reload) {
        await writeFolder(root, server.files, true);
        meta.revision = server.revision;
        await writeMeta(root, meta);
        log(t('Reloaded from the server: revision {0}.', meta.revision));
        throw new CtfError('cancelled');
      } else {
        throw new CtfError('cancelled');
      }
    }
  }
}

/** A run's verdict: draft_test_run or draft_solve, then draft_run every 5 s while pending. */
async function run(tool: 'draft_test_run' | 'draft_solve'): Promise<any> {
  const { meta } = await send();
  return vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: t('Running on the bench…'), cancellable: true },
    async (_p, cancel) => {
      let r = await call(meta.url, tool, { id: meta.id });
      for (let i = 0; r?.status === 'pending'; i++) {
        if (cancel.isCancellationRequested || i >= MAX_POLLS) {
          log(t('Run {0} still pending; read it later.', r.run));
          return r;
        }
        await new Promise((ok) => setTimeout(ok, pollMs));
        r = await call(meta.url, 'draft_run', { id: meta.id, run: r.run });
      }
      out.show(true);
      if (tool === 'draft_test_run' && r?.status === 'passed') tried.set(meta.id, meta.revision);
      log(t('Run {0}: {1}', r?.run, r?.status));
      for (const c of r?.checks ?? []) log(`  check ${JSON.stringify(c)}`);
      const events: unknown[] = r?.events ?? [];
      for (const ev of events.slice(0, 200)) log(`  ${JSON.stringify(ev)}`);
      if (events.length > 200) log(t('  … {0} more events', events.length - 200));
      return r;
    });
}

async function check(): Promise<any> {
  const { meta } = await send();
  const r = await call(meta.url, 'draft_lint', { id: meta.id });
  out.show(true);
  lints.set(meta.id, { revision: meta.revision, errors: (r?.errors ?? []).map(String) });
  log(r?.ok ? t('Check: no error.') : t('Check: {0} error(s).', (r?.errors ?? []).length));
  for (const e of r?.errors ?? []) log(`  - ${e}`);
  return r;
}

async function submit(): Promise<any> {
  const { meta } = await send();
  const r = await call(meta.url, 'draft_submit', { id: meta.id });
  out.show(true);
  log(t('Sent to review: version {0}.', r?.version));
  return r;
}

async function comments(): Promise<any> {
  // no send first: a write would take a draft under review back to draft
  const meta = await readMeta(await findDraft());
  const list: any[] = await call(meta.url, 'review_comments', { id: meta.id });
  out.show(true);
  log(list.length ? t('{0} remark(s):', list.length) : t('No remark yet.'));
  for (const c of list) {
    log(`[${c.at}] ${c.by} · ${c.verdict}`);
    for (const line of String(c.body ?? '').split('\n')) log(`    ${line}`);
  }
  return list;
}

// --- Player ---------------------------------------------------------------------------------------------------------

async function playerEnv(): Promise<NodeJS.ProcessEnv> {
  let site: string | undefined;
  try {
    site = await secrets.get(siteKey(settingUrl()));
  } catch {
    site = undefined;
  }
  return site ? { ...process.env, PICODEV_SITE_AUTH: site } : process.env;
}

const cwd = () => vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

let hasPicodev: boolean | undefined; // known after the first picodev status
let game: Game | undefined;
let built: boolean | undefined; // this game's last build: compiled, failed, not yet
let sent = false;
let warnedEnd = ''; // the game whose 5-minute warning was shown
// a code from a vscode:// link, in this window's memory only, at most 15 minutes: never written, never logged
let pending: { code: string; timer: NodeJS.Timeout } | undefined;
let problems: vscode.DiagnosticCollection;
let boardTerm: vscode.Terminal | undefined;
let watchPanel: vscode.WebviewPanel | undefined;
const trees: Tree[] = [];

function notify(text: string, action: string, cmd: string) {
  void vscode.window.showInformationMessage(text, action).then((r) => r === action && vscode.commands.executeCommand(cmd));
}

async function noPicodev(): Promise<void> {
  const open = t('Open in VS Code');
  const r = await vscode.window.showWarningMessage(
    t('The picodev command is not here: open a challenge\'s container (a starter project) first.'), open);
  if (r === open) await openStarter();
}

async function openStarter(family?: string): Promise<void> {
  family ??= await vscode.window.showQuickPick([...FAMILIES], { title: t('Family of the bench') });
  if (family) await vscode.env.openExternal(vscode.Uri.parse(starterLink(family)));
}

function setPending(code?: string) {
  if (pending) clearTimeout(pending.timer);
  pending = code ? { code, timer: setTimeout(() => setPending(), 15 * 60_000) } : undefined;
  render();
}

async function login(code?: string): Promise<number | string | undefined> {
  code ??= await vscode.window.showInputBox({
    title: t('Game code'),
    prompt: t('The 8-character code on the game screen ("use my machine").'),
    ignoreFocusOut: true,
  });
  if (code === undefined) return;
  const args = loginArgs(code, settingUrl()); // refuses anything but a game code before any process runs
  const r = await picodev(args, cwd(), await playerEnv(), 120_000);
  if (r.code === 'ENOENT') return void (await noPicodev());
  log(`$ picodev login …\n${r.stdout}${r.stderr}`);
  if (r.code === 0) {
    setPending();
    void vscode.window.showInformationMessage(t('Joined the game.'));
  } else {
    void vscode.window.showErrorMessage(t('picodev login failed: {0}', r.stderr.trim().split('\n').pop() ?? String(r.code)));
  }
  await refreshStatus();
  return r.code;
}

/** vscode://picodev.picodev-ctf/join?code=<code>: only the code is taken; the address stays picodevCtf.url's. */
async function handleUri(uri: vscode.Uri): Promise<unknown> {
  if (uri.path !== '/join') return;
  const code = normCode(new URLSearchParams(uri.query).get('code'));
  if (!code) throw new CtfError('bad_code');
  if (hasPicodev === undefined) await refreshStatus();
  if (hasPicodev) return login(code);
  setPending(code);
  const open = t('Open the starter project');
  const r = await vscode.window.showInformationMessage(
    t('Game code received, kept 15 minutes in this window\'s memory. There is no picodev command here: open the starter project of the challenge\'s family in its container, then click "Back to VS Code" on the game screen again (or "Join" in the Game view).'),
    open);
  if (r === open) await openStarter();
}

/** The compilers' lines of a build or a send in the Problems panel, mapped to the workspace; the errors' count. */
function showProblems(r: Ran): number {
  problems.clear();
  const roots = (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath);
  const byFile = new Map<string, vscode.Diagnostic[]>();
  let errors = 0;
  for (const d of parseDiagnostics(`${r.stdout}\n${r.stderr}`)) {
    const file = mapPath(d.file, cwd() ?? '/', roots, existsSync);
    if (!file) continue; // a toolchain's header, not the player's file
    const diag = new vscode.Diagnostic(new vscode.Range(Math.max(0, d.line - 1), Math.max(0, d.col - 1), Math.max(0, d.line - 1), 1000),
      d.message, d.severity === 'warning' ? vscode.DiagnosticSeverity.Warning : vscode.DiagnosticSeverity.Error);
    diag.source = 'picodev';
    if (d.severity === 'error') errors++;
    byFile.set(file, [...(byFile.get(file) ?? []), diag]);
  }
  for (const [file, list] of byFile) problems.set(vscode.Uri.file(file), list);
  return errors;
}

async function compileWith(cmd: 'build' | 'send'): Promise<Ran> {
  const r = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `picodev ${cmd}…` },
    async () => picodev([cmd], cwd(), await playerEnv(), 15 * 60_000));
  if (r.code === 'ENOENT') return r;
  log(`$ picodev ${cmd}\n${r.stdout}${r.stderr}`);
  const errors = showProblems(r);
  if (r.code === 0) built = true;
  else if (errors) built = false;
  if (r.code !== 0) {
    out.show(true);
    void vscode.window.showErrorMessage(errors
      ? t('picodev {0}: {1} error(s), see the Problems panel.', cmd, errors)
      : t('picodev {0} failed: see the output.', cmd));
  }
  return r;
}

async function build(): Promise<number | string | undefined> {
  const r = await compileWith('build');
  if (r.code === 'ENOENT') return void (await noPicodev());
  if (r.code === 0) vscode.window.setStatusBarMessage(t('Built.'), 5000);
  render();
  return r.code;
}

async function playerSend(): Promise<number | string | undefined> {
  const r = await compileWith('send');
  if (r.code === 'ENOENT') return void (await noPicodev());
  if (r.code === 0) sent = true;
  await refreshStatus();
  return r.code;
}

async function refreshStatus(): Promise<void> {
  if (hasPicodev === false) return;
  const r = await picodev(['status'], cwd(), await playerEnv(), 30_000);
  if (r.code === 'ENOENT') {
    hasPicodev = false; // not a challenge's container: stop asking
    return render();
  }
  hasPicodev = true;
  const before = game;
  game = r.code === 0 ? readStatus(r.stdout) : undefined; // exit 3: no game; 4: the game ended
  if (r.code === 4) notify(t('The game is over.'), t('Start a game'), 'picodevCtf.launch');
  if (game && game.challenge !== before?.challenge) {
    built = undefined;
    sent = false;
  } else if (game?.level !== undefined && before?.level !== undefined && game.level > before.level) {
    notify(game.levels ? t('Level {0}/{1} reached.', game.level + 1, game.levels) : t('Level {0} reached.', game.level + 1),
      t('Game screen'), 'picodevCtf.gameScreen');
  }
  const left = game?.expires_at === undefined ? undefined : game.expires_at - Date.now() / 1000;
  if (game && left !== undefined && left > 0 && left <= 300 && warnedEnd !== `${game.challenge}:${game.expires_at}`) {
    warnedEnd = `${game.challenge}:${game.expires_at}`;
    notify(t('5 minutes left in the game: the flag is handed in on the game screen.'), t('Game screen'), 'picodevCtf.gameScreen');
  }
  render();
}

/** The game's screen on the site, <url>/defis/<challenge>. */
async function gameUrl(): Promise<string> {
  if (!game) await refreshStatus();
  const slug = slugOf(game?.challenge);
  if (!slug) throw new CtfError('no_game');
  return `${settingUrl()}/defis/${slug}`;
}

async function gameScreen(): Promise<void> {
  await vscode.env.openExternal(vscode.Uri.parse(await gameUrl()));
}

/** Hints and abandon, until the extension has a player's sign-in: on the game screen, said before it opens. */
async function onGameScreen(text: string): Promise<boolean> {
  const url = await gameUrl();
  const open = t('Open the game screen');
  if ((await vscode.window.showWarningMessage(text, { modal: true }, open)) !== open) return false;
  return vscode.env.openExternal(vscode.Uri.parse(url));
}

/** The board's events (`picodev events --follow`) in a terminal of their own: picodev itself, no shell. */
async function boardConsole(): Promise<void> {
  if (hasPicodev === false) return noPicodev();
  if (boardTerm && boardTerm.exitStatus === undefined) return boardTerm.show();
  const site = (await playerEnv()).PICODEV_SITE_AUTH;
  boardTerm = vscode.window.createTerminal({
    name: t('Board console'), shellPath: 'picodev', shellArgs: ['events', '--follow'], cwd: cwd(),
    env: site ? { PICODEV_SITE_AUTH: site } : undefined,
    isTransient: true, // never revived from VS Code's storage, which would keep its environment
    iconPath: new vscode.ThemeIcon('pulse'),
  });
  boardTerm.show();
}

/** Voir la partie: the site's Regarder page of `picodev watch`'s link, framed in a tab; the link is never logged. */
async function watch(): Promise<string | undefined> {
  const origin = settingUrl();
  const r = await picodev(['watch'], cwd(), await playerEnv(), 30_000);
  if (r.code === 'ENOENT') return void (await noPicodev());
  if (r.code !== 0) {
    if (/invalid choice/.test(r.stderr)) {
      notify(t('This container\'s picodev has no watch command (an image older than the extension): update the container, or watch the game from its screen.'),
        t('Game screen'), 'picodevCtf.gameScreen');
    } else {
      void vscode.window.showErrorMessage(t('picodev watch failed: {0}', r.stderr.trim().split('\n').pop() ?? String(r.code)));
    }
    return;
  }
  const p = watchPath(r.stdout, origin);
  if (!p) throw new CtfError('bad_watch');
  if (!watchPanel) {
    // scripts on: a frame inherits the webview's sandbox, and the Regarder page needs its own; the CSP of watchHtml
    // gives the webview's document none
    watchPanel = vscode.window.createWebviewPanel('picodevCtf.watch', t('Game · {0}', game?.challenge || 'Picodev CTF'),
      vscode.ViewColumn.Beside, { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [] });
    watchPanel.onDidDispose(() => (watchPanel = undefined));
  }
  watchPanel.webview.html = watchHtml(origin, p);
  watchPanel.reveal();
  return p;
}

// --- Catalogue ------------------------------------------------------------------------------------------------------

/** A public GET of the site (no cookie), with the staging site's password when it asks for one. */
async function siteGet(origin: string, p: string): Promise<any> {
  for (let asked = false; ; asked = true) {
    const site = await secrets.get(siteKey(origin));
    let res: Response;
    try {
      res = await fetch(`${transport() ?? origin}${p}`, {
        headers: site ? { Authorization: 'Basic ' + Buffer.from(site).toString('base64') } : {},
        redirect: 'error',
        signal: AbortSignal.timeout(30_000),
      });
    } catch (e) {
      throw new CtfError('network', String((e as Error).message ?? e));
    }
    if (res.status === 401 && /basic/i.test(res.headers.get('www-authenticate') ?? '')) {
      if (asked) throw new CtfError('site_password');
      const s = await askSite(origin);
      if (!s) throw new CtfError('cancelled');
      await secrets.store(siteKey(origin), s);
      continue;
    }
    if (!res.ok) throw new CtfError(`http_${res.status}`);
    return res.json().catch(() => {
      throw new CtfError('bad_response');
    });
  }
}

/** Lancer une partie: the catalogue's challenges and courses in one search; the game opens on the site. */
async function launch(): Promise<string | undefined> {
  const origin = settingUrl();
  const cat = await siteGet(origin, '/api/catalogue');
  const list = (x: unknown): any[] => (Array.isArray(x) ? x : []);
  const items = [
    ...list(cat?.challenges).filter((c) => slugOf(c?.slug)).map((c) => ({
      label: String(titleOf(c.title) || c.slug),
      description: [t('challenge'), c.platform, c.theme, Number.isInteger(c.points) ? `${c.points} pts` : '']
        .filter((x) => typeof x === 'string' && x).join(' · '),
      detail: String(titleOf(c.summary) ?? ''),
      url: `${origin}/defis/${c.slug}?poste=machine&retour=vscode`,
    })),
    ...list(cat?.courses).filter((c) => slugOf(c?.slug)).map((c) => ({
      label: String(titleOf(c.title) || c.slug),
      description: [t('course'), list(c.platforms).filter((x) => typeof x === 'string').join(', '),
        Number.isInteger(c.reading_minutes) ? `${c.reading_minutes} min` : ''].filter(Boolean).join(' · '),
      detail: String(titleOf(c.summary) ?? ''),
      url: `${origin}/cours/${c.slug}`,
    })),
  ];
  const pick = await vscode.window.showQuickPick(items, {
    title: t('Start a game'),
    placeHolder: t('Search a title, a summary or a theme; filter by typing challenge, course, a platform (nano, esp32…) or points'),
    matchOnDescription: true,
    matchOnDetail: true,
  });
  if (!pick) return;
  await vscode.env.openExternal(vscode.Uri.parse(pick.url));
  return pick.url;
}

// --- Views ----------------------------------------------------------------------------------------------------------

class Tree implements vscode.TreeDataProvider<vscode.TreeItem> {
  readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changed.event;
  constructor(readonly items: () => vscode.TreeItem[] | Promise<vscode.TreeItem[]>) {}
  getTreeItem(i: vscode.TreeItem) {
    return i;
  }
  getChildren(i?: Node) {
    return i ? i.children ?? [] : this.items();
  }
}

type Node = vscode.TreeItem & { children?: vscode.TreeItem[] };

function item(label: string, icon: string, command?: string, args?: unknown[]): vscode.TreeItem {
  const i = new vscode.TreeItem(label);
  i.iconPath = new vscode.ThemeIcon(icon);
  if (command) i.command = { command, title: label, arguments: args };
  return i;
}

/** The one "Next: …" line of a view, highlighted. */
function nextItem([label, command]: [string, string]): vscode.TreeItem {
  const i = item(label, 'arrow-right', command);
  i.label = { label, highlights: [[0, label.length]] };
  i.iconPath = new vscode.ThemeIcon('arrow-right', new vscode.ThemeColor('charts.orange'));
  return i;
}

/** The player's single next step. */
function nextStep(): [string, string] {
  if (!hasPicodev) {
    return pending ? [t('Next: open the starter project in its container'), 'picodevCtf.openStarter']
      : [t('Next: start a game'), 'picodevCtf.launch'];
  }
  if (!game) return pending ? [t('Next: join the game (code received)'), 'picodevCtf.joinPending'] : [t('Next: join a game'), 'picodevCtf.login'];
  if (built === false) return [t('Next: fix the errors (Problems panel)'), 'workbench.actions.view.problems'];
  if (!built) return [t('Next: build'), 'picodevCtf.build'];
  if (!sent) return [t('Next: send to the bench'), 'picodevCtf.playerSend'];
  return [t('Next: hand in the flag on the game screen'), 'picodevCtf.gameScreen'];
}

function actionItems(): vscode.TreeItem[] {
  const items = [nextItem(nextStep())];
  if (!game) items.push(item(t('Join a game'), 'sign-in', 'picodevCtf.login'), item(t('Start a game'), 'search', 'picodevCtf.launch'));
  if (!hasPicodev) items.push(item(t('Open a starter project'), 'remote', 'picodevCtf.openStarter'));
  if (game) {
    items.push(
      item(t('Build'), 'tools', 'picodevCtf.build'),
      item(t('Send to the bench'), 'cloud-upload', 'picodevCtf.playerSend'),
      item(t('Watch the game'), 'eye', 'picodevCtf.watch'),
      item(t('Board console'), 'terminal', 'picodevCtf.console'),
      item(t('Game screen'), 'link-external', 'picodevCtf.gameScreen'),
      item(t('Status'), 'refresh', 'picodevCtf.status'),
      item(t('Ask for a hint'), 'lightbulb', 'picodevCtf.hint'),
      item(t('Abandon the game'), 'close', 'picodevCtf.abandon'));
  }
  return items;
}

function gameItems(): vscode.TreeItem[] {
  if (!game) return []; // the view's welcome says what to do
  const left = minutesLeft(game);
  const items = [nextItem(nextStep()), item(t('Challenge: {0}', game.challenge || '…'), 'target', 'picodevCtf.gameScreen')];
  if (game.level !== undefined) {
    items.push(item(game.levels ? t('Level {0}/{1}', game.level + 1, game.levels) : t('Level {0}', game.level + 1), 'layers'));
  }
  if (left !== undefined) items.push(item(t('{0} min left', left), 'watch'));
  return items;
}

/** The author's single next step: the open draft's state on the server, then this window's last check and try. */
function authorNext(meta: Meta | undefined, row: any, list: any[]): [string, string] {
  if (!meta) return list.length ? [t('Next: open a draft'), 'picodevCtf.openDraft'] : [t('Next: new challenge'), 'picodevCtf.newChallenge'];
  if (row?.state === 'changes') return [t('Next: read the reviewers\' remarks'), 'picodevCtf.comments'];
  if (row?.state === 'review') return [t('Next: wait for the review (remarks)'), 'picodevCtf.comments'];
  if (row?.state === 'approved' || row?.state === 'published') return [t('Next: new challenge'), 'picodevCtf.newChallenge'];
  if (row && row.revision !== meta.revision) return [t('Next: send the draft (revision {0} on the server)', row.revision), 'picodevCtf.send'];
  const lint = lints.get(meta.id);
  if (lint?.revision !== meta.revision) return [t('Next: check the draft'), 'picodevCtf.check'];
  if (lint.errors.length) return [t('Next: fix the check\'s errors, then check again'), 'picodevCtf.check'];
  if (row?.solved_revision === meta.revision) return [t('Next: send to review'), 'picodevCtf.submit'];
  return tried.get(meta.id) === meta.revision ? [t('Next: solve (reference solution)'), 'picodevCtf.solve']
    : [t('Next: try on its bench'), 'picodevCtf.try'];
}

/** The open draft folder: revision, solved_revision, the last check, and its parts done, in progress or to do. */
async function draftNode(root: string, meta: Meta, row: any): Promise<Node> {
  const lint = lints.get(meta.id);
  const errors = lint?.revision === meta.revision ? lint.errors : undefined;
  const paths = Object.keys((await readFolder(root).catch(() => ({ files: {} }))).files);
  const labels = {
    sheet: t('Sheet (challenge.json)'), program: t('Starting program'), target: t('Target (private/target.json)'),
    solution: t('Reference solution (private/)'), course: t('Course (course/)'),
  };
  const progress = { done: ['pass', t('done')], doing: ['edit', t('in progress')], todo: ['circle-large-outline', t('to do')] };
  const checked = item(errors ? (errors.length ? t('Check: {0} error(s).', errors.length) : t('Check: no error.'))
    : t('Check: not run at this revision'), errors?.length ? 'error' : 'checklist', 'picodevCtf.check');
  checked.tooltip = errors?.join('\n');
  const node: Node = item(row?.slug ?? path.basename(root), 'folder-active');
  node.description = row?.state;
  node.collapsibleState = vscode.TreeItemCollapsibleState.Expanded;
  node.children = [
    item(t('Revision {0}', meta.revision), 'versions'),
    ...(row ? [item(row.solved_revision == null ? t('Not solved yet') : t('Solved at revision {0}', row.solved_revision),
      row.solved_revision === meta.revision ? 'pass' : 'circle-large-outline', 'picodevCtf.solve')] : []),
    checked,
    ...sections(paths, errors).map(([s, p]) => Object.assign(item(labels[s], progress[p][0]), { description: progress[p][1] })),
  ];
  return node;
}

async function authorItems(): Promise<vscode.TreeItem[]> {
  const origin = await Promise.resolve().then(settingUrl).catch(() => undefined);
  const token = origin && await secrets.get(tokenKey(origin));
  if (!origin || !token) return []; // the welcome asks for the token
  try {
    drafts ??= await call(origin, 'draft_list', {}) as any[];
  } catch (e) {
    log(`! draft_list: ${e instanceof CtfError ? e.code : e}`);
  }
  const list = drafts ?? [];
  const found = (await vscode.workspace.findFiles(`**/${META}`, '**/node_modules/**', 1))[0];
  const root = found && path.dirname(found.fsPath);
  const meta = root ? await readMeta(root).catch(() => undefined) : undefined;
  const row = meta?.url === origin ? list.find((d) => d.id === meta.id) : undefined;
  const mine: Node = item(t('My drafts ({0})', list.length), 'list-unordered');
  mine.collapsibleState = vscode.TreeItemCollapsibleState.Collapsed;
  mine.children = list.map((d) => Object.assign(item(String(d.slug), 'file-code', 'picodevCtf.openDraft', [d]),
    { description: `${d.state} · r${d.revision}`, tooltip: String(titleOf(d.title)) }));
  const draft = !!root;
  return [
    nextItem(authorNext(meta, row, list)),
    ...(root && meta ? [await draftNode(root, meta, row)] : []),
    ...(list.length ? [mine] : []),
    item(t('New challenge'), 'new-folder', 'picodevCtf.newChallenge'),
    item(t('Open a draft'), 'folder-opened', 'picodevCtf.openDraft'),
    ...(draft ? [
      item(t('Send the draft'), 'cloud-upload', 'picodevCtf.send'),
      item(t('Check'), 'checklist', 'picodevCtf.check'),
      item(t('Try on its bench'), 'beaker', 'picodevCtf.try'),
      item(t('Solve (reference solution)'), 'pass', 'picodevCtf.solve'),
      item(t('Send to review'), 'send', 'picodevCtf.submit'),
      item(t('Reviewers\' remarks'), 'comment-discussion', 'picodevCtf.comments'),
    ] : []),
    item(t('Forget the author token'), 'trash', 'picodevCtf.forgetToken'),
    item('picodev.fr', 'globe', 'vscode.open', [vscode.Uri.parse('https://picodev.fr')]), // the container's only link out
  ];
}

function render() {
  void vscode.commands.executeCommand('setContext', 'picodevCtf.picodev', hasPicodev === true);
  void vscode.commands.executeCommand('setContext', 'picodevCtf.game', !!game);
  void vscode.commands.executeCommand('setContext', 'picodevCtf.pending', !!pending);
  if (hasPicodev) {
    status.text = game ? statusText(game) : t('$(target) no game');
    status.tooltip = game ? t('Picodev CTF game (picodev status)') : t('Join a game');
    status.command = game ? 'picodevCtf.game.focus' : 'picodevCtf.login';
    status.show();
  } else {
    status.hide();
  }
  for (const tree of trees) tree.changed.fire();
}

// --- Activation -----------------------------------------------------------------------------------------------------

export function activate(context: vscode.ExtensionContext) {
  secrets = context.secrets;
  testing = context.extensionMode === vscode.ExtensionMode.Test;
  if (testing) pollMs = 50;
  out = vscode.window.createOutputChannel('Picodev CTF');
  status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  problems = vscode.languages.createDiagnosticCollection('picodev');
  const version = context.extension.packageJSON.version;

  // The author MCP for the agent. The token goes in at resolve time only, so no definition VS Code may keep holds it.
  mcpChanged = new vscode.EventEmitter<void>();
  const mcp: vscode.McpServerDefinitionProvider<vscode.McpHttpServerDefinition> = {
    onDidChangeMcpServerDefinitions: mcpChanged.event,
    provideMcpServerDefinitions: async () => {
      let origin: string;
      try {
        origin = settingUrl();
      } catch {
        return [];
      }
      if (!(await secrets.get(tokenKey(origin)))) return [];
      return [new vscode.McpHttpServerDefinition('Picodev CTF (author)', vscode.Uri.parse(`${origin}/mcp/author`), {}, version)];
    },
    resolveMcpServerDefinition: async (def) => {
      const origin = checkUrl(def.uri.with({ path: '' }).toString());
      const token = await secrets.get(tokenKey(origin));
      if (!token) return undefined;
      const site = await secrets.get(siteKey(origin));
      def.headers = { 'X-CTF-Author-Token': token, ...(site ? { Authorization: 'Basic ' + Buffer.from(site).toString('base64') } : {}) };
      return def;
    },
  };

  const views = { actions: new Tree(actionItems), game: new Tree(gameItems), courses: new Tree(() => []), author: new Tree(authorItems) };
  trees.push(...Object.values(views));
  const authorChanged = () => {
    drafts = undefined;
    views.author.changed.fire();
  };
  // the Author view read again after an author command, whatever its outcome
  const authored = (run: (...args: any[]) => Promise<unknown>) => async (...args: any[]) => {
    try {
      return await run(...args);
    } finally {
      authorChanged();
    }
  };
  const timer = setInterval(() => void refreshStatus(), STATUS_MS);
  context.subscriptions.push(
    out, status, problems, mcpChanged, { dispose: () => clearInterval(timer) },
    ...Object.entries(views).map(([id, tree]) => vscode.window.registerTreeDataProvider(`picodevCtf.${id}`, tree)),
    mcpChanged.event(authorChanged),
    vscode.workspace.onDidChangeWorkspaceFolders(() => views.author.changed.fire()),
    vscode.window.registerUriHandler({ handleUri: (uri) => void guarded(handleUri)(uri) }),
    vscode.lm.registerMcpServerDefinitionProvider('picodev-ctf-author', mcp),
    vscode.workspace.onDidChangeConfiguration((e) => e.affectsConfiguration('picodevCtf.url') && mcpChanged.fire()),
    command('picodevCtf.setToken', setToken),
    command('picodevCtf.forgetToken', forgetToken),
    command('picodevCtf.newChallenge', authored(newChallenge)),
    command('picodevCtf.openDraft', authored(openDraft)),
    command('picodevCtf.send', authored(async () => (await send()).meta)),
    command('picodevCtf.check', authored(check)),
    command('picodevCtf.try', authored(() => run('draft_test_run'))),
    command('picodevCtf.solve', authored(() => run('draft_solve'))),
    command('picodevCtf.submit', authored(submit)),
    command('picodevCtf.comments', authored(comments)),
    command('picodevCtf.login', login),
    command('picodevCtf.joinPending', async () => (pending ? login(pending.code) : login())),
    command('picodevCtf.launch', launch),
    command('picodevCtf.build', build),
    command('picodevCtf.playerSend', playerSend),
    command('picodevCtf.watch', watch),
    command('picodevCtf.console', boardConsole),
    command('picodevCtf.gameScreen', gameScreen),
    command('picodevCtf.status', refreshStatus),
    command('picodevCtf.hint', () => onGameScreen(
      t('Hints are asked for on the game screen, which shows a hint\'s cost in points before revealing it. Open the game screen?'))),
    command('picodevCtf.abandon', () => onGameScreen(
      t('A game is abandoned on the game screen, after its own confirmation. Open the game screen?'))),
    command('picodevCtf.courses', async () => vscode.env.openExternal(vscode.Uri.parse(`${settingUrl()}/cours`))),
    command('picodevCtf.openStarter', openStarter),
  );
  render();
  void refreshStatus();

  return testing ? {
    mcp,
    logText: () => logged,
    statusText: () => (status as any).text as string,
    handleUri: (uri: vscode.Uri) => guarded(handleUri)(uri),
    views,
    watchHtml: () => watchPanel?.webview.html,
    noPicodev: () => (hasPicodev = false), // a window outside a challenge's container
  } : undefined;
}

export function deactivate() {}
