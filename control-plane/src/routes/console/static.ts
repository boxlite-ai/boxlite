/** The console's static files under /console/ (the built dashboard), with the SPA fallback to index.html. */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, join, resolve, sep } from 'node:path';
import type { Context } from 'hono';

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json',
  '.webmanifest': 'application/manifest+json',
};

export function staticHandler(c: Context, consoleDir: string | undefined): Response {
  const dir = resolve(consoleDir ?? '../console-dist');
  const rel = decodeURIComponent(new URL(c.req.url).pathname.slice('/console/'.length));
  const file = resolve(dir, rel || 'index.html');
  if (file !== dir && !file.startsWith(dir + sep)) return c.text('not found', 404);
  const isFile = existsSync(file) && statSync(file).isFile();
  // SPA fallback: a route path (no extension) gets index.html; a missing asset is a 404.
  const target = isFile ? file : extname(rel) ? null : join(dir, 'index.html');
  if (!target || !existsSync(target)) {
    return c.text(target ? `The console is not built. Run deploy/build-console.sh (looked in ${dir}).` : 'not found', 404);
  }
  const hashed = target.includes(`${sep}assets${sep}`);
  return new Response(readFileSync(target), {
    headers: {
      'content-type': TYPES[extname(target).toLowerCase()] ?? 'application/octet-stream',
      'cache-control': hashed ? 'public, max-age=31536000, immutable' : 'no-cache',
      'x-content-type-options': 'nosniff',
    },
  });
}
