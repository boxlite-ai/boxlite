# proxy-rs

The BoxLite preview proxy. Routes `<port>-<boxId | signedToken>.<domain>` to a
port inside a box, decides who is allowed in, and keeps the box awake while
someone is using it.

Replaces the Go `apps/proxy`, which stays in the tree as a rollback path until
this has soaked.

## How a request is resolved

```
hostname            3000-d-416243644566313233343536.proxy.boxlite.ai
                    └──┬─┘ └──────────────┬───────────────┘ └───┬────┘
                     port        box ID or signed token      base host
```

1. **Public?** `GET /preview/{box}/public` (cached 3s).
2. **If not** — or if the port is the terminal (`22222`) — authenticate, in
   order: `Authorization: Bearer`, `X-BoxLite-Preview-Token`,
   `?BOXLITE_BOX_AUTH_KEY=`, a signed `boxlite-box-auth-*` cookie, the hostname
   itself being a signed preview token. A browser with none of them is sent
   through OIDC and comes back to `/callback` on the base host.
3. **Forward.** A guest port is reached by opening
   `CONNECT /v1/boxes/{box}/network/tunnel?port=N` against the box's runner and
   speaking HTTP over it; the terminal goes to the runner's own API. WebSockets
   and client `CONNECT` tunnels ride the same path.

Endpoints served by the proxy itself, on the base host: `GET /health`,
`GET /callback`, `POST /accept-boxlite-preview-warning`.

## Configuration

| Variable | Required | Meaning |
| --- | --- | --- |
| `PROXY_PORT` | yes | Listen port. |
| `PROXY_PROTOCOL` | yes | `http` or `https` — the scheme clients reach the proxy on. Sets `X-Forwarded-Proto` and the `Secure` cookie flag. |
| `PROXY_API_KEY` | yes | Control-plane credential; also the cookie signing key. |
| `BOXLITE_API_URL` | yes | Control-plane base URL, including any `/api` prefix. |
| `COOKIE_DOMAIN` | | Pins one cookie domain. Derived from the request host otherwise. |
| `ENABLE_TLS`, `TLS_CERT_FILE`, `TLS_KEY_FILE` | | Terminate TLS in-process. Unset when a load balancer does it. |
| `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET`, `OIDC_DOMAIN`, `OIDC_AUDIENCE` | | Login settings. Anything unset is taken from the API's `/config`. |
| `OIDC_PUBLIC_DOMAIN` | | Split-horizon issuer: browsers use the public address, the proxy uses `OIDC_DOMAIN`. |
| `REDIS_HOST`, `REDIS_PORT`, `REDIS_USERNAME`, `REDIS_PASSWORD`, `REDIS_TLS` | | Share caches across replicas. Per-process caching without them. |
| `PREVIEW_WARNING_ENABLED` | | Show the interstitial to browsers on first visit. |
| `SHUTDOWN_TIMEOUT_SEC` | | How long to drain before forcing exit. Default 1 hour. |
| `RUST_LOG` | | Log filter. Default `info`. |

`.env`, `.env.local`, and `.env.production` are loaded from the working
directory and override exported variables, in that order.

## Working on it

```sh
cargo test          # unit tests + the tunnel/forwarding integration tests
cargo clippy --all-targets -- -D warnings
cargo fmt
```

From the `apps/` nx workspace: `nx test proxy-rs`, `nx lint proxy-rs`,
`nx serve proxy-rs`, `nx docker proxy-rs`.
