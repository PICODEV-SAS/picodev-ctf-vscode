// A draft on the author's disk: the folder of draft_folder, plus .picodev-draft.json (never a token).
import * as fs from 'fs/promises';
import * as path from 'path';
import { CtfError, checkUrl } from './mcp';

export const META = '.picodev-draft.json';
const MAX_BYTES = 2 * 1024 * 1024; // the server takes 1 MiB per draft; past twice that the folder is not a draft

export interface Meta {
  url: string;
  id: number;
  revision: number;
  with_agent: boolean;
}

export const SLUG = /^c-[a-z0-9]+(-[a-z0-9]+)*$/;

/** A relative path of the server's folder that stays inside it: no absolute path, no `.` or `..`, no backslash. */
export function safePath(p: unknown): p is string {
  if (typeof p !== 'string' || p.length === 0 || p.length > 255 || p.includes('\\') || p.includes('\0')) return false;
  if (p.startsWith('/') || /^[A-Za-z]:/.test(p) || p === META) return false;
  return p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/**
 * Writes the server's folder under `root`, every path checked before anything is written, symbolic links never
 * followed.
 * `prune` also removes the local files the next send would carry that the server no longer has (a reload).
 */
export async function writeFolder(root: string, files: Record<string, unknown>, prune = false): Promise<void> {
  if (!files || typeof files !== 'object') throw new CtfError('bad_response');
  for (const [p, text] of Object.entries(files)) {
    if (!safePath(p)) throw new CtfError('unsafe_path', p);
    if (typeof text !== 'string') throw new CtfError('bad_response', p);
  }
  await fs.mkdir(root, { recursive: true });
  const real = await fs.realpath(root);
  // the folders made one by one: a link (or a file) already on the way is refused before anything goes through it
  const walk = async (p: string, make: boolean): Promise<string> => {
    const segments = p.split('/');
    let dir = real;
    for (const s of segments.slice(0, -1)) {
      dir = path.join(dir, s);
      const st = await fs.lstat(dir).catch(() => undefined);
      if (!st && !make) return dir; // nothing further exists
      if (!st) await fs.mkdir(dir);
      else if (!st.isDirectory()) throw new CtfError('unsafe_path', p);
    }
    const target = path.join(dir, segments.at(-1)!);
    const st = await fs.lstat(target).catch(() => undefined);
    if (st && !st.isFile()) throw new CtfError('unsafe_path', p);
    return target;
  };
  for (const p of Object.keys(files)) await walk(p, false); // every path checked before the first write
  for (const [p, text] of Object.entries(files) as [string, string][]) await fs.writeFile(await walk(p, true), text);
  if (prune) {
    for (const p of Object.keys((await readFolder(real)).files)) if (!(p in files)) await fs.rm(path.join(real, ...p.split('/')));
  }
}

/**
 * The text files a send carries: everything but .picodev-draft.json, hidden entries, build* entries and symbolic
 * links (never followed: a link could carry any file of the disk). Binary files are skipped and listed.
 */
export async function readFolder(root: string): Promise<{ files: Record<string, string>; skipped: string[] }> {
  const files: Record<string, string> = {};
  const skipped: string[] = [];
  let total = 0;
  const walk = async (dir: string, rel: string[]) => {
    for (const e of (await fs.readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      if (e.name.startsWith('.') || e.name.startsWith('build')) continue;
      const p = [...rel, e.name];
      if (e.isDirectory()) await walk(path.join(dir, e.name), p);
      else if (!e.isFile()) skipped.push(p.join('/'));
      else {
        const buf = await fs.readFile(path.join(dir, e.name));
        if ((total += buf.length) > MAX_BYTES) throw new CtfError('too_large');
        try {
          const text = new TextDecoder('utf-8', { fatal: true }).decode(buf);
          if (text.includes('\0')) throw new Error();
          files[p.join('/')] = text;
        } catch {
          skipped.push(p.join('/'));
        }
      }
    }
  };
  await walk(root, []);
  return { files, skipped };
}

export async function readMeta(root: string): Promise<Meta> {
  let m: any;
  try {
    m = JSON.parse(await fs.readFile(path.join(root, META), 'utf8'));
  } catch {
    throw new CtfError('no_draft', root);
  }
  const ok = m && typeof m.url === 'string' && Number.isSafeInteger(m.id) && m.id > 0 && Number.isSafeInteger(m.revision)
    && typeof m.with_agent === 'boolean';
  if (!ok) throw new CtfError('no_draft', root);
  return { url: checkUrl(m.url), id: m.id, revision: m.revision, with_agent: m.with_agent };
}

export async function writeMeta(root: string, m: Meta): Promise<void> {
  const { url, id, revision, with_agent } = m; // exactly these four fields, never anything else
  await fs.writeFile(path.join(root, META), JSON.stringify({ url, id, revision, with_agent }, null, 2) + '\n');
}

/** JSON with its keys sorted: two JSON files that only differ in layout are the same. */
const canonical = (v: unknown): string => JSON.stringify(v, (_k, x) =>
  x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => a.localeCompare(b))) : x);

/** Whether the local folder holds what the server has (a .json compared by its content, not its layout). */
export function sameFolder(local: Record<string, string>, server: Record<string, string>): boolean {
  const keys = Object.keys(local);
  if (keys.length !== Object.keys(server).length) return false;
  return keys.every((k) => {
    if (!(k in server)) return false;
    if (local[k] === server[k]) return true;
    if (!k.endsWith('.json')) return false;
    try {
      return canonical(JSON.parse(local[k])) === canonical(JSON.parse(server[k]));
    } catch {
      return false;
    }
  });
}

export type Section = 'sheet' | 'program' | 'target' | 'solution' | 'course';
export type Progress = 'done' | 'doing' | 'todo';

/** The paths of the folder that make each part of a draft (draft_folder's layout). */
const HAS: Record<Section, (p: string) => boolean> = {
  sheet: (p) => p === 'challenge.json',
  program: (p) => p !== 'challenge.json' && !/^(private|course)\//.test(p),
  target: (p) => p === 'private/target.json',
  solution: (p) => p.startsWith('private/') && p !== 'private/target.json',
  course: (p) => p.startsWith('course/'),
};
/** The part a draft_lint error names, by tools.check's `where` (first match); any other error is the sheet's. */
const NAMED: [Section, RegExp][] = [
  ['course', /^course /], ['target', /\/private\/target\.json\b/], ['solution', /\bprivate\/solution/],
  ['sheet', /challenge\.json/], ['program', /\.(ino|c|h|cpp)\b/],
];

/**
 * Each part of a draft: to do when the folder has none of it, in progress while the last check names it or has not
 * run at this revision (errors undefined), else done. The course is optional: listed once the folder has one.
 */
export function sections(paths: string[], errors: string[] | undefined): [Section, Progress][] {
  const named = new Set(errors?.map((e) => NAMED.find(([, re]) => re.test(e))?.[0] ?? 'sheet'));
  return (Object.keys(HAS) as Section[]).filter((s) => s !== 'course' || paths.some(HAS.course)).map((s) =>
    [s, !paths.some(HAS[s]) ? 'todo' : !errors || named.has(s) ? 'doing' : 'done']);
}
