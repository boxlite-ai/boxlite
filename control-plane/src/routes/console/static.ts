/**
 * The console's static files under /console/ (the built dashboard, with the SPA fallback to
 * index.html) and the vendored libraries under /console/vendor/ (control-plane/vendor, no fallback).
 */
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
  return serve(c, resolve(consoleDir ?? '../console-dist'), '/console/', true);
}

/** control-plane/vendor, from the working directory like console-dist (the server runs in control-plane/). */
export const VENDOR_DIR = resolve('vendor');

/** Third-party files the console and its sign-in page load (vendor/README.md in each); public, like the sign-in page. */
export function vendorHandler(c: Context): Response {
  return serve(c, VENDOR_DIR, '/console/vendor/', false);
}

function serve(c: Context, dir: string, prefix: string, spa: boolean): Response {
  const rel = decodeURIComponent(new URL(c.req.url).pathname.slice(prefix.length));
  const file = resolve(dir, rel || 'index.html');
  if (file !== dir && !file.startsWith(dir + sep)) return c.text('not found', 404);
  const isFile = existsSync(file) && statSync(file).isFile();
  // SPA fallback: a route path (no extension) gets index.html; a missing asset is a 404.
  const target = isFile ? file : spa && !extname(rel) ? join(dir, 'index.html') : null;
  if (!target || !existsSync(target)) {
    return c.text(target ? `The console is not built. Run deploy/build-console.sh (looked in ${dir}).` : 'not found', 404);
  }
  // Only the build's assets/ carry a content hash in their names; anything else (index.html, the
  // vendor runtime files) must be revalidated, or browsers keep an old copy for a year.
  const hashed = spa && target.includes(`${sep}assets${sep}`);
  return new Response(readFileSync(target), {
    headers: {
      'content-type': TYPES[extname(target).toLowerCase()] ?? 'application/octet-stream',
      'cache-control': hashed ? 'public, max-age=31536000, immutable' : 'no-cache',
      'x-content-type-options': 'nosniff',
    },
  });
}
