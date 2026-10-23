/** The HTML pages, redirects and JSON 401 that sign-in answers with. */
import { brandPage } from '../http/brand-page.js';

export function htmlPage(title: string, body: string, status: number, headers: Headers = new Headers()): Response {
  // The BoxLite look of every CP page (http/brand-page.ts); `body` is the caller's escaped markup.
  return brandPage({ title, tone: status >= 500 ? 'error' : status >= 400 ? 'stopped' : 'progress', label: title, bodyHtml: body }, status, headers);
}

export const wantsHtml = (method: string, headers: Headers) => (method === 'GET' || method === 'HEAD') && (headers.get('accept') ?? '').includes('text/html');

export function unauthenticated(): Response {
  const next = 'send users to /.boxlite/auth/login?next=<path>; agents verify a protected path with `boxlite-app app curl <path> --as <email>`';
  return new Response(JSON.stringify({ error: { code: 'unauthenticated', message: 'sign in required', next } }), { status: 401, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
}

export const noAccessPage = (headers?: Headers) =>
  htmlPage('No access', "<h1>You don't have access to this site</h1><p>The site's owner has blocked your account.</p>", 403, headers);

export const redirect = (location: string, headers: Headers = new Headers()) => {
  headers.set('location', location);
  headers.set('cache-control', 'no-store');
  return new Response(null, { status: 302, headers });
};
