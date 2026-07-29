# proxy (superseded)

Superseded by [`apps/proxy-rs`](../proxy-rs), which is what deploys. This Go
implementation is kept only as a rollback path and is scheduled for removal.

To roll back, point the `Proxy` service in `apps/infra/sst.config.ts` at
`apps/proxy/Dockerfile` and redeploy.

Do not add features here — they will be lost when this directory is deleted.
