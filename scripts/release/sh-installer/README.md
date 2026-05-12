# sh.boxlite.ai installer Worker

A tiny Cloudflare Worker that serves the boxlite-cli installer at
`https://sh.boxlite.ai`, enabling:

```sh
curl -fsSL https://sh.boxlite.ai | sh
```

The Worker is a byte-passthrough proxy for the latest GitHub Release's
`install.sh`. The install script's trust model (sigstore attestation,
embedded SHA256 checksums, `.sha256` sidecars) is unchanged — see
[`../install.sh.template`](../install.sh.template).

## Local dev

```sh
cd scripts/release/sh-installer
npx wrangler dev
# Then in another terminal:
curl -fsSL http://localhost:8787 | head -20
```

## Deploy

The Worker source rarely changes, so deploys are manual.

```sh
cd scripts/release/sh-installer
npx wrangler login          # first time only — opens a browser
npx wrangler deploy
```

On first deploy, Cloudflare auto-provisions the `sh.boxlite.ai` DNS record
and TLS cert (since `boxlite.ai` is already a Cloudflare-managed zone, and
`wrangler.toml` has `custom_domain = true`).

## Verify after deploy

```sh
# Content matches upstream byte-for-byte
diff <(curl -fsSL https://sh.boxlite.ai) \
     <(curl -fsSL https://github.com/boxlite-ai/boxlite/releases/latest/download/install.sh)

# Pinning a version still works
BOXLITE_VERSION=v0.9.4 curl -fsSL https://sh.boxlite.ai | sh
```
