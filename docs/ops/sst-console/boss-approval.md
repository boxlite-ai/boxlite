# SST Console — one approval needed (read-only visualization)

**Ask:** approve connecting the BoxLite dev stage to the SST Console
(console.sst.dev) using a **read-only, name-scoped, boundary-carrying** IAM role.

## What it is

SST Console is the official dashboard for SST apps: see resources, logs, and a
per-deploy "what changed" history. We want it purely as a **view** into dev — it
made our recent deploy-drift debugging slow because we had no such view.

## What you're approving (and what you're NOT)

```
APPROVING:
  · A 3rd-party SaaS (Anomaly Inc., the SST company) may assume ONE role in
    account 064212132677, cross-account, gated by an ExternalId.
  · That role is READ-ONLY (describe stacks, get functions, read logs/metrics,
    read SST state buckets). No write, no deploy, no iam mutation.
  · It is named `boxlite-sst-console-reader` and carries `boxlite-role-boundary`,
    so it complies with the account's role rules and cannot exceed the boundary
    ceiling even if mis-modified.

NOT in this approval (separate decisions later):
  · Autodeploy / CodeBuild (would need deploy-level IAM) — NOT requested now.
  · Error "Issues" tracking (needs log-subscription write) — NOT requested now.
  · prod stages (need billing; and a separate review) — dev only.
```

## Why it's safe

- **Least privilege:** the role only has the read actions the Console needs
  (template: `docs/ops/sst-console/iam-console-reader.cfn.yaml`). Not Admin.
  (The Console's *default* template is `AdministratorAccess` — we explicitly do
  NOT use it.)
- **Boundary-capped:** carries `boxlite-role-boundary`, so it physically cannot do
  iam/sso/org/billing even if the policy were widened by mistake.
- **ExternalId + name-scoped:** cross-account assume is gated; the role name fits
  the account's `boxlite-*` rule.
- **Reversible:** delete one CloudFormation stack (us-east-1) + remove the account
  in the Console. No app/infra change involved.

## Cost

Free for dev (≤350 active resources; dev ≈250). Viewing prod later needs billing
(≈$43/mo for dev+prod) — not part of this ask.

## If you say no

Totally fine — we fall back to self-hosted visualization (Grafana/CloudWatch
dashboards), which keeps everything in our own account with no 3rd party. See
`docs/ops/sst-console/visualization-options.md`. The read-only Console is just the
faster option *if* you're OK with the scoped 3rd-party role.

**Decision:** ☐ approve read-only dev connect  ☐ no — use self-hosted instead
