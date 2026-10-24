/** Path rules of an app origin: safe `next` targets, path normalisation, and `[auth].protect` matching. */

/**
 * `next` is a path on the app's own origin. Anything that could leave it is refused: a scheme,
 * `//host`, backslashes, dot segments (also percent-encoded) and control characters.
 */
export function safeNext(next: string | null | undefined): string | null {
  if (next === null || next === undefined || next === '') return '/';
  let p = next;
  if (/[\u0000-\u001f\u007f\\]/.test(p)) return null;
  if (/^[a-z][a-z0-9+.-]*:/i.test(p) || p.startsWith('//')) return null;
  if (!p.startsWith('/')) p = `/${p}`;
  if (p.startsWith('//')) return null;
  const path = p.split(/[?#]/)[0]!;
  if (path.split('/').some((seg) => ['.', '..'].includes(seg.replace(/%2e/gi, '.')))) return null;
  return p;
}

/** Decoded, slashes collapsed, dot segments resolved: roughly what an upstream router sees. */
export function normalisePath(raw: string): string {
  try {
    return new URL(decodeURIComponent(raw).replace(/\/{2,}/g, '/'), 'http://x').pathname;
  } catch {
    return raw;
  }
}

function globRe(pattern: string): RegExp {
  const body = pattern.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*');
  // `/app/*` also covers `/app` itself.
  const tail = pattern.endsWith('/*') ? `|${body.slice(0, -'/.*'.length)}` : '';
  return new RegExp(`^(?:${body}${tail})$`, 'i');
}

/**
 * `[auth].protect` globs against the request path. `*` spans segments. The path is also checked
 * decoded and normalised, and case-insensitively, so `/APP/x`, `/%61pp/x` or `//app/x` cannot
 * reach a route the app's router would treat as `/app/x`.
 */
export function isProtected(patterns: string[], path: string): boolean {
  if (!patterns.length) return false;
  const raw = path.split('?')[0] || '/';
  const normal = normalisePath(raw);
  return patterns.some((pat) => {
    const re = globRe(pat);
    return re.test(raw) || re.test(normal);
  });
}

/**
 * `public_paths` globs, which open paths of a private app, so stricter than `isProtected`: the raw
 * path and its decoded, normalised form must both match, and a path with an encoded slash, a
 * backslash or a dot segment is never public (an app router that decodes `%2F` or resolves `..`
 * could otherwise serve `/admin` for `/webhooks/..%2Fadmin`).
 */
export function isPublicPath(patterns: string[], path: string): boolean {
  if (!patterns.length) return false;
  const raw = path.split('?')[0] || '/';
  if (/%2f|%5c|\\/i.test(raw)) return false;
  if (raw.split('/').some((seg) => ['.', '..'].includes(seg.replace(/%2e/gi, '.')))) return false;
  const normal = normalisePath(raw);
  return patterns.some((pat) => {
    const re = globRe(pat);
    return re.test(raw) && re.test(normal);
  });
}
