# Auth0 Universal Login assets

The tenant template loads these immutable public assets from the Cloudflare
Pages project `boxlite-auth-assets-boxlite-ai`:

| Published path            | Source                                                                  | SHA-256                                                            |
| ------------------------- | ----------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `boxlite-light.png`       | `apps/dashboard/src/assets/boxlite-light.png`                           | `ec0b124340e956a6619e866809e2dad8e5f75e83e10a301c766ecdd81710f8e0` |
| `ibm-plex-mono-400.woff2` | `@ibm/plex-mono@2.5.0` `fonts/complete/woff2/IBMPlexMono-Regular.woff2` | `ba204497f16b6d334cee9d1e963a831b73e3a56e1d6300a8489d18df7214b350` |
| `ibm-plex-mono-500.woff2` | `@ibm/plex-mono@2.5.0` `fonts/complete/woff2/IBMPlexMono-Medium.woff2`  | `33faf307fa6031fb4062276d7320a6d632de890cbb347576fd80cfa01077bc25` |
| `IBM-Plex-OFL.txt`        | `@ibm/plex-mono@2.5.0` `LICENSE.txt`                                    | `7e6b2818edbd8f6a01ae80641cc8f16a51080d08fb4e532be3a0b6f74adb07da` |

The npm package is published under `OFL-1.1` from
<https://github.com/IBM/plex>. Keep the license beside the font files in every
deployment.

The Pages upload also includes this `_headers` rule:

```text
/*
  Access-Control-Allow-Origin: *
  X-Content-Type-Options: nosniff
```

Cloudflare parses `_headers` instead of serving it. The wildcard is deliberate:
dev and prod use different Auth0 origins, while these files contain no private
data. `bootstrap.ts` probes both availability and CORS before it writes any
tenant branding.
