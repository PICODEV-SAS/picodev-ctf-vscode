// A course of the site in VS Code's Markdown preview: a virtual document (picodev-course:/<slug>.md) and a markdown-it
// plugin that holds it to the contract. The preview's engine is shared by every document and parses without knowing
// which one (env.currentDocument is set at render only), so the plugin works on the renderer's rules, and only when
// the document rendered is of this scheme: every other preview stays as it was.
import { slugOf } from './player';

export const SCHEME = 'picodev-course';
const IMAGE = /^img\/([A-Za-z0-9._-]+)$/;

/** The course of a picodev-course document, from its path /<slug>.md. */
export const courseSlug = (path: string) => slugOf(path.match(/^\/([^/]+)\.md$/)?.[1]);

/** GET /api/courses/{slug} as one Markdown text: its chapters in order, in `lang`, else the other language. */
export function courseText(course: any, lang: 'fr' | 'en'): string {
  const other = lang === 'fr' ? 'en' : 'fr';
  const chapters: any[] = Array.isArray(course?.chapters) ? course.chapters : [];
  return chapters.map((c) => c?.[lang] ?? c?.[other]).filter((c) => c && typeof c.body === 'string')
    .map((c) => `# ${String(c.title ?? '').replace(/\n/g, ' ')}\n\n${c.body}`).join('\n\n');
}

/** The course's own image (`img/<nom>`, rebuilt on the pinned origin), else undefined. */
export function imageUrl(src: string, origin: string, slug: string): string | undefined {
  const name = src.match(IMAGE)?.[1];
  return name && !name.includes('..') ? `${origin}/api/courses/${slug}/img/${name}` : undefined;
}

/** A link the course may keep: https (or the local address) to the pinned origin only. */
export function linkOk(href: string, origin: string): boolean {
  try {
    const u = new URL(href);
    return u.origin === origin && !u.username && !u.password;
  } catch {
    return false;
  }
}

/** The plugin; `origin()` is picodevCtf.url's origin, or throws when the setting is not a valid address. */
export function coursePlugin(md: any, origin: () => string): any {
  const rules = md.renderer.rules;
  const esc: (s: string) => string = md.utils.escapeHtml;
  // the pinned origin and the course of the document rendered, undefined when it is not a course
  const course = (env: any): { origin: string; slug: string } | undefined => {
    const doc = env?.currentDocument;
    if (doc?.scheme !== SCHEME) return undefined;
    let o = '';
    try {
      o = origin();
    } catch {
      // no valid address: links and images all become text
    }
    return { origin: o, slug: courseSlug(doc.path) ?? '' };
  };
  const wrap = (name: string, mine: (tokens: any[], idx: number, c: { origin: string; slug: string }) => string | undefined) => {
    const orig = rules[name];
    rules[name] = (tokens: any[], idx: number, opts: any, env: any, self: any) => {
      const c = course(env);
      const own = c && mine(tokens, idx, c);
      if (own !== undefined) return own;
      return orig ? orig(tokens, idx, opts, env, self) : self.renderToken(tokens, idx, opts);
    };
  };
  const dropped = (tok: any, c: { origin: string }) => !c.origin || !linkOk(String(tok.attrGet('href') ?? ''), c.origin);
  // no HTML: shown as its text
  wrap('html_block', (tokens, idx) => esc(tokens[idx].content));
  wrap('html_inline', (tokens, idx) => esc(tokens[idx].content));
  // a link elsewhere (command:, vscode:, file:, another site, a relative one): its text only. Links do not nest, so a
  // link_close's link is the last link_open before it.
  wrap('link_open', (tokens, idx, c) => (dropped(tokens[idx], c) ? '' : undefined));
  wrap('link_close', (tokens, idx, c) => {
    for (let j = idx - 1; j >= 0; j--) if (tokens[j].type === 'link_open') return dropped(tokens[j], c) ? '' : undefined;
    return undefined;
  });
  // VS Code's own image rule runs first and keeps the course's src in data-src; the tokens are cached per document
  // version, so the image is written here rather than in them
  wrap('image', (tokens, idx, c) => {
    const tok = tokens[idx];
    const url = c.origin && c.slug ? imageUrl(String(tok.attrGet('data-src') ?? tok.attrGet('src') ?? ''), c.origin, c.slug) : undefined;
    const alt = esc(String(tok.content ?? ''));
    return url ? `<img src="${esc(url)}" alt="${alt}">` : alt;
  });
  return md;
}
