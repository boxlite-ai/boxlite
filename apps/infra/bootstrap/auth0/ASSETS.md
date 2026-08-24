# Auth0 Universal Login assets

The browser loads Universal Login branding from the same stage-specific origin
as the BoxLite dashboard. The source files live in
`apps/dashboard/public/auth0/`; Vite copies `public/` into the dashboard build,
the API image includes that build, and Nest serves it through the stack domain.

| Public file                        | Source                                                                  | SHA-256                                                            |
| ---------------------------------- | ----------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `boxlite-light-ec0b1243.png`       | `apps/dashboard/src/assets/boxlite-light.png`                           | `ec0b124340e956a6619e866809e2dad8e5f75e83e10a301c766ecdd81710f8e0` |
| `ibm-plex-mono-400-ba204497.woff2` | `@ibm/plex-mono@2.5.0` `fonts/complete/woff2/IBMPlexMono-Regular.woff2` | `ba204497f16b6d334cee9d1e963a831b73e3a56e1d6300a8489d18df7214b350` |
| `IBM-Plex-OFL-d741e57d.txt`        | `@ibm/plex-mono@2.5.0` `LICENSE.txt` (normalized text)                  | `d741e57d5f865e294df801f96b7b5161a88b211df65887e4358d271c9fc5fb4f` |

IBM Plex Mono is published under OFL-1.1 by
<https://github.com/IBM/plex>. Keep the license beside the fonts.

## Runtime contract

The checked-in theme uses `https://__BOXLITE_STACK_DOMAIN__/auth0/...`.
Bootstrap replaces that token with the selected stage's `STACK_DOMAIN`; dev and
prod therefore own independent URLs without duplicating configuration files.
It deliberately does not call Auth0's paid-only Universal Login page-template
endpoint, so the workflow remains compatible with Auth0 Free.

`apps/api/src/serve-static-cache.ts` gives `/auth0/` files:

```text
Cache-Control: public, max-age=31536000, immutable
Access-Control-Allow-Origin: *
X-Content-Type-Options: nosniff
```

The wildcard is limited to public, immutable brand assets and supports separate
dev and prod Auth0 origins. Content hashes are part of every referenced filename,
so immutable caching cannot pin Auth0 to changed bytes under an old URL.

Deploy the dashboard/API image before applying Auth0 branding. Before its first
Auth0 write, bootstrap GETs every referenced URL with the tenant origin and
requires HTTP 200, the expected `image/png` or `font/woff2` media type, a nonempty
bounded body, and a compatible CORS header. The media-type check is necessary
because an SPA fallback can return HTML with status 200 for a missing asset.

When an asset changes: compute its full SHA-256, put the first eight characters
in the filename, update this table and `branding-theme.json`, deploy the
dashboard, and only then rerun `--provision-auth0-branding`.
