/** The HTML pages, redirects and JSON 401 that sign-in answers with. */
import { escapeHtml } from '../http/html.js';

export function htmlPage(title: string, body: string, status: number, headers: Headers = new Headers()): Response {
  headers.set('content-type', 'text/html; charset=utf-8');
  headers.set('cache-control', 'no-store');
  const doc = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title>
<style>body{font:15px/1.5 system-ui,sans-serif;max-width:38rem;margin:15vh auto;padding:0 1rem;color:#222}h1{font-size:1.3rem}code{background:#f3f3f3;padding:0 .25rem}a.btn{display:block;max-width:18rem;border:1px solid #ccc;border-radius:6px;padding:.6rem 1rem;margin:.6rem 0;color:#222;text-decoration:none}a.btn:hover{background:#f6f6f6}</style></head><body>${body}</body></html>`;
  return new Response(doc, { status, headers });
}

export const wantsHtml = (method: string, headers: Headers) => (method === 'GET' || method === 'HEAD') && (headers.get('accept') ?? '').includes('text/html');

export function unauthenticated(): Response {
  const next = 'send users to /.boxlite/auth/login?next=<path>; agents verify a protected path with `boxlite-app app curl <path> --as <email>`';
  return new Response(JSON.stringify({ error: { code: 'unauthenticated', message: 'sign in required', next } }), { status: 401, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
}

export const noAccessPage = (app: string, headers?: Headers) =>
  htmlPage('No access', `<h1>You don't have access to ${escapeHtml(app)}</h1><p>The owner of this app has blocked your account.</p>`, 403, headers);

export const redirect = (location: string, headers: Headers = new Headers()) => {
  headers.set('location', location);
  headers.set('cache-control', 'no-store');
  return new Response(null, { status: 302, headers });
};
