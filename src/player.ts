// The player's side: the container's `picodev` command, run without a shell, with validated arguments only.
import { execFile } from 'child_process';
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

export const ARGS = /^(login|send|status)$/;

/** Runs `picodev <args>` by execFile (no shell). Only login, send and status, as built above. */
export function picodev(args: string[], cwd: string | undefined, env: NodeJS.ProcessEnv, timeout: number): Promise<Ran> {
  if (!ARGS.test(args[0] ?? '')) throw new CtfError('bad_args');
  return new Promise((resolve) => {
    execFile('picodev', args, { cwd, env, timeout, maxBuffer: 4 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
      const code = err ? ((err as NodeJS.ErrnoException).code ?? (err as any).signal ?? 1) : 0;
      resolve({ code: code as number | string, stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

/** The status bar text of `picodev status`'s JSON line, or undefined when it does not read as one. */
export function statusText(json: string, now = Date.now() / 1000): string | undefined {
  let s: any;
  try {
    s = JSON.parse(json.trim().split('\n').pop() ?? '');
  } catch {
    return undefined;
  }
  if (!s || typeof s !== 'object') return undefined;
  const challenge = String(s.challenge ?? '').replace(/[^\w.-]/g, '').slice(0, 40); // no $(icon) from outside
  const parts = [`$(target) ${challenge || 'CTF'}`];
  if (Number.isInteger(s.level) && Number.isInteger(s.levels)) parts.push(`${s.level + 1}/${s.levels}`);
  if (typeof s.expires_at === 'number') parts.push(`${Math.max(0, Math.round((s.expires_at - now) / 60))} min`);
  return parts.join(' · ');
}
