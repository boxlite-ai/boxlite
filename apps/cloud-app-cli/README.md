# Cloud App CLI

`boxlite-app` deploys and operates an App through the platform API. The handoff prompt provides
the organization API URL, CLI package URL, App name, and environment. Use an existing
organization API key with Apps permissions. `boxlite-app login` saves the key by
`BOXLITE_API_URL`. An explicit `BOXLITE_API_KEY` takes precedence over the saved credential.

Select the App with `--app <name>`, an existing `.boxlite/link.json`, or `BOXLITE_APP`.
`boxlite-app init --app <name>` links the directory for later `check`, `plan`, `apply`, and
`deploy` commands.
`boxlite-app docs` includes the Agent guide and command reference offline.

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
