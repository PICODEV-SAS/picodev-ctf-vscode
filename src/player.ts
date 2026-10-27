// The player's side: the container's `picodev` command, run without a shell, with validated arguments only.
import { execFile } from 'child_process';
import * as path from 'path';
import { DEFAULT_URL, CtfError, checkUrl } from './mcp';

/** A game code: 8 characters of Crockford's base32 (no I, L, O, U). */
export const CODE = /^[0-9A-HJKMNP-TV-Z]{8}$/;
export const FAMILIES = ['avr', 'esp32', 'stm32', 'nrf52'] as const;

/** `picodev login [--url <origin>] <code>`; a code that is not a game code is refused, never passed on. */
export function loginArgs(code: string, url: string): string[] {
  const c = code.trim().toUpperCase();
  if (!CODE.test(c)) throw new CtfError('bad_code', code);
  const origin = checkUrl(url);
  return ['login', ...(origin === DEFAULT_URL ? [] : ['--url', origin]), c];
}

/** The "Open in VS Code" link of a family's starter repository (contract: PICODEV-SAS/picodev-starter-<family>). */
export function starterLink(family: string): string {
  if (!(FAMILIES as readonly string[]).includes(family)) throw new CtfError('bad_family', family);
  return `vscode://ms-vscode-remote.remote-containers/cloneInVolume?url=https://github.com/PICODEV-SAS/picodev-starter-${family}`;
}

export interface Ran {
  code: number | string; // the exit code, or the error's code (ENOENT: no picodev here)
  stdout: string;
  stderr: string;
}

// `picodev events --follow` runs in a terminal of its own (extension.ts, no shell either), never through here
export const ARGS = /^(login|send|status|build|watch)$/;

/** Runs `picodev <args>` by execFile (no shell). Only login, send, status, build and watch, as built here. */
export function picodev(args: string[], cwd: string | undefined, env: NodeJS.ProcessEnv, timeout: number): Promise<Ran> {
  if (!ARGS.test(args[0] ?? '')) throw new CtfError('bad_args');
  return new Promise((resolve) => {
    execFile('picodev', args, { cwd, env, timeout, maxBuffer: 4 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
      const code = err ? ((err as NodeJS.ErrnoException).code ?? (err as any).signal ?? 1) : 0;
      resolve({ code: code as number | string, stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

export interface Game {
  challenge: string; // a slug's characters only, '' when the status had none
  level?: number;
  levels?: number;
  expires_at?: number;
}

/** `picodev status`'s last JSON line, its fields checked; undefined when it does not read as one. */
export function readStatus(json: string): Game | undefined {
  let s: any;
  try {
    s = JSON.parse(json.trim().split('\n').pop() ?? '');
  } catch {
    return undefined;
  }
  if (!s || typeof s !== 'object') return undefined;
  return {
    challenge: String(s.challenge ?? '').replace(/[^\w.-]/g, '').slice(0, 40), // no $(icon) from outside
    level: Number.isInteger(s.level) ? s.level : undefined,
    levels: Number.isInteger(s.levels) ? s.levels : undefined,
    expires_at: typeof s.expires_at === 'number' ? s.expires_at : undefined,
  };
}

/** Minutes left in a game, or undefined when the status has no end. */
export const minutesLeft = (g: Game, now = Date.now() / 1000) =>
  g.expires_at === undefined ? undefined : Math.max(0, Math.round((g.expires_at - now) / 60));

/** The status bar text of a game. */
export function statusText(s: Game, now = Date.now() / 1000): string {
  const parts = [`$(target) ${s.challenge || 'CTF'}`];
  if (s.level !== undefined && s.levels !== undefined) parts.push(`${s.level + 1}/${s.levels}`);
  const left = minutesLeft(s, now);
  if (left !== undefined) parts.push(`${left} min`);
  return parts.join(' · ');
}

/** A game code from a link: case, spaces and dashes ignored; undefined unless 8 characters of Crockford's base32. */
export function normCode(raw: unknown): string | undefined {
  if (typeof raw !== 'string' || raw.length > 32) return undefined;
  const c = raw.replace(/[\s-]/g, '').toUpperCase();
  return CODE.test(c) ? c : undefined;
}

/** The spectator link of the contract: the site's Regarder page, the hub's session and viewer token in the fragment. */
export const WATCH = /^\/regarder#[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

/**
 * The /regarder#<session>.<viewer> of `picodev watch`'s output: the bare value, or the absolute link the command
 * prints, whose origin must then be `origin`. Undefined for anything else.
 */
export function watchPath(out: string, origin: string): string | undefined {
  const line = out.trim().split('\n').pop()?.trim() ?? '';
  let p = line;
  if (!line.startsWith('/')) {
    try {
      const u = new URL(line);
      if (u.origin !== origin) return undefined;
      p = u.pathname + u.search + u.hash;
    } catch {
      return undefined;
    }
  }
  return WATCH.test(p) ? p : undefined;
}

/** The "Voir la partie" tab: a frame of the site's Regarder page and nothing else, no script of its own (CSP). */
export function watchHtml(origin: string, watch: string): string {
  if (!WATCH.test(watch)) throw new CtfError('bad_watch');
  const o = checkUrl(origin);
  // the sandbox keeps the page's scripts and its origin (its connection to the hub), and takes away popups, forms
  // and the navigation of VS Code's frames
  return `<!DOCTYPE html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; frame-src ${o}; style-src 'unsafe-inline'">
<style>html,body,iframe{margin:0;padding:0;border:0;width:100%;height:100%;overflow:hidden}</style></head>
<body><iframe src="${o}${watch}" sandbox="allow-scripts allow-same-origin" title="Picodev CTF"></iframe></body></html>`;
}

export interface Diag {
  file: string;
  line: number;
  col: number;
  severity: 'error' | 'warning';
  message: string;
}

/** The compilers' `file:line[:col]: error|warning: message` lines (gcc, arduino-cli, west, idf.py). */
export function parseDiagnostics(log: string): Diag[] {
  const out: Diag[] = [];
  const re = /^(.+?):(\d+):(?:(\d+):)?\s*(fatal error|error|warning):\s*(.+)$/gm;
  for (const m of log.replace(/\x1b\[[0-9;]*m/g, '').matchAll(re)) {
    out.push({ file: m[1].trim(), line: +m[2], col: +(m[3] ?? 1), severity: m[4] === 'warning' ? 'warning' : 'error', message: m[5].trim() });
  }
  return out;
}

/**
 * A compiler's path (a container path) as a file of the workspace: as it is when it lies in a workspace folder, else
 * the longest tail of it found in one (a copy compiled in a build folder). Undefined: not one of the player's files.
 */
export function mapPath(file: string, cwd: string, roots: string[], exists: (p: string) => boolean): string | undefined {
  const abs = path.resolve(cwd, file);
  if (roots.some((r) => abs.startsWith(r.endsWith(path.sep) ? r : r + path.sep)) && exists(abs)) return abs;
  const segs = abs.split(path.sep).filter(Boolean);
  for (let i = 1; i < segs.length; i++) {
    for (const r of roots) {
      const p = path.join(r, ...segs.slice(i));
      if (exists(p)) return p;
    }
  }
  return undefined;
}

/** A slug for the site's addresses (/defis/<slug>, /cours/<slug>), else undefined. */
export const slugOf = (s: unknown): string | undefined => (typeof s === 'string' && /^[a-z0-9][a-z0-9-]{0,63}$/.test(s) ? s : undefined);
