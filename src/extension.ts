import * as vscode from 'vscode';
import * as fs from 'fs/promises';
import * as path from 'path';
import { CtfError, DEFAULT_URL, callTool, checkUrl } from './mcp';
import { META, Meta, SLUG, readFolder, readMeta, sameFolder, writeFolder, writeMeta } from './draft';
import { FAMILIES, loginArgs, picodev, starterLink, statusText } from './player';

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
};

function fail(e: unknown) {
  if (e instanceof CtfError && e.code === 'cancelled') return;
  const code = e instanceof CtfError ? e.code : 'error';
  const text = MESSAGES[code]?.() ?? (e instanceof Error ? e.message : String(e));
  log(`! ${code}: ${e instanceof Error ? e.message : String(e)}`);
  void vscode.window.showErrorMessage(t('Picodev CTF: {0}', text));
}

function command(id: string, run: (...args: any[]) => Promise<unknown>): vscode.Disposable {
  return vscode.commands.registerCommand(id, async (...args: any[]) => {
    try {
      return await run(...args);
    } catch (e) {
      fail(e);
    }
  });
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
      site = (await vscode.window.showInputBox({
        title: t('Password of {0}', origin),
        prompt: t('This site is closed by a password: user:password.'),
        password: true,
        ignoreFocusOut: true,
        validateInput: (v) => (/^[^:\s]+:\S+$/.test(v) ? undefined : t('user:password')),
      }))?.trim();
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

async function openDraft(): Promise<string | undefined> {
  const origin = settingUrl();
  const list: any[] = await call(origin, 'draft_list', {});
  if (!list.length) {
    void vscode.window.showInformationMessage(t('No draft yet: "Picodev CTF: New challenge" makes one.'));
    return;
  }
  const item = await vscode.window.showQuickPick(
    list.map((d) => ({ label: String(d.slug), description: `${d.state} · r${d.revision}`, detail: String(titleOf(d.title)), d })),
    { title: t('Draft to open') });
  if (!item) return;
  const parent = await pickParent();
  if (!parent) return;
  return materialize(origin, item.d, parent);
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
  if (r.code === 0) void vscode.window.showInformationMessage(t('Joined the game.'));
  else void vscode.window.showErrorMessage(t('picodev login failed: {0}', r.stderr.trim().split('\n').pop() ?? String(r.code)));
  void refreshStatus();
  return r.code;
}

async function playerSend(): Promise<number | string | undefined> {
  const r = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: t('picodev send…') },
    async () => picodev(['send'], cwd(), await playerEnv(), 15 * 60_000));
  if (r.code === 'ENOENT') return void (await noPicodev());
  out.show(true);
  log(`$ picodev send\n${r.stdout}${r.stderr}`);
  if (r.code !== 0) void vscode.window.showErrorMessage(t('picodev send failed: see the output.'));
  void refreshStatus();
  return r.code;
}

let hasPicodev = true;

async function refreshStatus(): Promise<void> {
  if (!hasPicodev) return;
  const r = await picodev(['status'], cwd(), await playerEnv(), 30_000);
  if (r.code === 'ENOENT') {
    hasPicodev = false; // not a challenge's container: stop asking
    status.hide();
    return;
  }
  const text = r.code === 0 ? statusText(r.stdout) : undefined;
  if (text) {
    status.text = text;
    status.tooltip = t('Picodev CTF game (picodev status)');
    status.show();
  } else {
    status.hide(); // exit 3: no game; 4: the game ended
  }
}

// --- Activation -----------------------------------------------------------------------------------------------------

export function activate(context: vscode.ExtensionContext) {
  secrets = context.secrets;
  testing = context.extensionMode === vscode.ExtensionMode.Test;
  if (testing) pollMs = 50;
  out = vscode.window.createOutputChannel('Picodev CTF');
  status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  status.command = 'picodevCtf.status';
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

  const timer = setInterval(() => void refreshStatus(), STATUS_MS);
  context.subscriptions.push(
    out, status, mcpChanged, { dispose: () => clearInterval(timer) },
    vscode.lm.registerMcpServerDefinitionProvider('picodev-ctf-author', mcp),
    vscode.workspace.onDidChangeConfiguration((e) => e.affectsConfiguration('picodevCtf.url') && mcpChanged.fire()),
    command('picodevCtf.setToken', setToken),
    command('picodevCtf.forgetToken', forgetToken),
    command('picodevCtf.newChallenge', newChallenge),
    command('picodevCtf.openDraft', openDraft),
    command('picodevCtf.send', async () => (await send()).meta),
    command('picodevCtf.check', check),
    command('picodevCtf.try', () => run('draft_test_run')),
    command('picodevCtf.solve', () => run('draft_solve')),
    command('picodevCtf.submit', submit),
    command('picodevCtf.comments', comments),
    command('picodevCtf.login', login),
    command('picodevCtf.playerSend', playerSend),
    command('picodevCtf.status', refreshStatus),
    command('picodevCtf.openStarter', openStarter),
  );
  void refreshStatus();

  return testing ? { mcp, logText: () => logged, statusText: () => (status as any).text as string } : undefined;
}

export function deactivate() {}
