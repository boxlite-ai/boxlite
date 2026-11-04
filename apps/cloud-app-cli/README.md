# Cloud App CLI

`boxlite-app` deploys and operates an App through the platform API. Its handoff prompt supplies
an organization-scoped `BOXLITE_API_URL`, an App key, and the public `BOXLITE_CLI_URL` package.
Run `boxlite-app login` once, then use `init`, `check`, `plan`, `apply` and `deploy`.
`boxlite-app docs` includes the Agent guide and command reference offline.
`login` and `whoami` verify the App scope returned by the API. Credentials use the platform's
`blk_test_` or `blk_live_` format; their prefix alone does not identify the authorized App.
An explicit `BOXLITE_API_KEY` takes precedence over a saved credential.

Build and test from the repository root:

```sh
make build:apps:cloud-app-artifacts
make test:apps:cloud-app-cli
make test:apps:cloud-app-supervisor
```

The artifacts are placed in `apps/dist/apps/cloud-app-artifacts/`: the dependency-free npm
package, Agent guide and handoff template, and Linux Supervisor binaries for amd64 and arm64.
The API image contains the same directory. `CLOUD_APP_ARTIFACT_URL` and
`CLOUD_APP_ARTIFACT_VERSION` identify its public release; API organization paths do not identify
artifact URLs.

The Supervisor build accepts `RELEASE_KEY` for Ed25519 release signing. The API Docker build
accepts the BuildKit secret `cloud_app_release_key`; the key remains in the build stage's secret
mount. With no key, development artifacts are unsigned.
