# Auth0 Universal Login assets

The browser loads Universal Login branding from the selected stage's dashboard
origin. Source files live in `apps/dashboard/public/auth0/`; Vite copies them
into the dashboard build and Nest serves them through the stack domain.

| Public file                        | Source                                                                  | SHA-256                                                            |
| ---------------------------------- | ----------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `boxlite-light-ec0b1243.png`       | `apps/dashboard/src/assets/boxlite-light.png`                           | `ec0b124340e956a6619e866809e2dad8e5f75e83e10a301c766ecdd81710f8e0` |
| `ibm-plex-mono-400-ba204497.woff2` | `@ibm/plex-mono@2.5.0` `fonts/complete/woff2/IBMPlexMono-Regular.woff2` | `ba204497f16b6d334cee9d1e963a831b73e3a56e1d6300a8489d18df7214b350` |
| `IBM-Plex-OFL-d741e57d.txt`        | `@ibm/plex-mono@2.5.0` `LICENSE.txt` (normalized text)                  | `d741e57d5f865e294df801f96b7b5161a88b211df65887e4358d271c9fc5fb4f` |

IBM Plex Mono is published under OFL-1.1 by <https://github.com/IBM/plex>.
Keep the license beside the fonts.

## Runtime contract

`branding/theme.json` contains stage-relative `/auth0/*` paths. The Universal
Login command resolves only those known fields against the selected target's
`stackOrigin`; it does not substitute arbitrary strings in the document.

Before reading Auth0 state, the command verifies the live stack identity and
GETs every asset with the public Auth0 origin. It requires HTTP 200, the
expected `image/png` or `font/woff2` media type, a nonempty bounded body, and a
compatible CORS header.

`apps/api/src/serve-static-cache.ts` gives `/auth0/` files:

```text
Cache-Control: public, max-age=31536000, immutable
Access-Control-Allow-Origin: *
X-Content-Type-Options: nosniff
```

When an asset changes, compute its full SHA-256, put the first eight characters
in the filename, update this table and `branding/theme.json`, deploy the
dashboard, then run `npm run auth0:universal-login -- preview --stage <name>`.
