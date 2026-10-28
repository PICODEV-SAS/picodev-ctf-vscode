// The author MCP of the CTF (/mcp/author: stateless HTTP, JSON responses), one tools/call per request. No MCP client
// library: a JSON-RPC POST is all the server needs.

export const DEFAULT_URL = 'https://ctf.picodev.fr';
const TIMEOUT_MS = 150_000; // draft_test_run and draft_solve wait 120 s for their verdict on the server

/** An error with the server's code (stale, unknown_draft, ...) or one of ours (bad_url, site_auth_required, ...). */
export class CtfError extends Error {
  constructor(readonly code: string, message = code) {
    super(message);
  }
}

/**
 * The origin of an https address (http for localhost and 127.0.0.1 only), the key of its secrets; anything else
 * (http://, credentials, a path) refused.
 */
export function checkUrl(raw: string): string {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    throw new CtfError('bad_url', raw);
  }
  const local = u.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(u.hostname);
  if ((u.protocol !== 'https:' && !local) || u.username || u.password || u.search || u.hash || !['', '/'].includes(u.pathname)) {
    throw new CtfError('bad_url', raw);
  }
  return u.origin;
}

export interface Auth {
  token: string;
  site?: string; // user:password of the staging site (Caddy basic auth)
}

/**
 * Calls one tool of the author MCP at `origin` and returns its structured result. `transport` replaces the origin for
 * the request only (the integration test's mock server); the token never leaves in anything but its header.
 */
export async function callTool(origin: string, name: string, args: object, auth: Auth, transport?: string): Promise<any> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
    'X-CTF-Author-Token': auth.token,
  };
  if (auth.site) headers.Authorization = 'Basic ' + Buffer.from(auth.site).toString('base64');
  let res: Response;
  try {
    res = await fetch(`${transport ?? checkUrl(origin)}/mcp/author`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
      redirect: 'error', // a redirect would carry the token header to wherever it points
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (e) {
    throw new CtfError('network', String((e as Error).message ?? e));
  }
  if (res.status === 401) {
    // Caddy's password (staging) asks for Basic; the service's own 401 is a missing or refused token
    throw new CtfError(/basic/i.test(res.headers.get('www-authenticate') ?? '') ? 'site_auth_required' : 'author_token_required');
  }
  if (!res.ok) throw new CtfError(res.status === 413 ? 'too_large' : `http_${res.status}`);
  const body: any = await res.json().catch(() => {
    throw new CtfError('bad_response');
  });
  if (body?.error) throw new CtfError('mcp_error', String(body.error.message ?? ''));
  const result = body?.result;
  if (!result) throw new CtfError('bad_response');
  if (result.isError) {
    const text = String(result.content?.[0]?.text ?? '').replace(`Error executing tool ${name}: `, '');
    throw new CtfError(text.match(/^([a-z_]+)(?::|$)/)?.[1] ?? 'tool_error', text);
  }
  const out = 'structuredContent' in result ? result.structuredContent : JSON.parse(result.content?.[0]?.text ?? 'null');
  // a list comes back wrapped as {result: [...]}
  return out && typeof out === 'object' && !Array.isArray(out) && Object.keys(out).length === 1 && 'result' in out ? out.result : out;
}
