# SST Console — onboarding runbook (read-only visualization first)

> Goal: get the SST Console (console.sst.dev) showing BoxLite's **dev** stage —
> resources, logs, and deploy history — with the **minimum, safe** AWS footprint.
> We deliberately start read-only (no Issues, no Autodeploy). Those are separate,
> reviewed changes later.
>
> **What this does NOT do:** replace our deploy pipeline, touch prod, or change
> any GitHub Actions. It only adds a *view*.

## TL;DR of who does what

```
Claude (already done, in this repo):
  · docs/ops/sst-console/iam-console-reader.cfn.yaml  ← the scoped, bounded read-only role
  · this runbook + the migration analysis + the boss-approval one-pager
Brian (browser, ~10 min — cannot be automated):
  · steps 1–5 below (sign up, connect AWS with OUR template, connect dev)
Boss (one approval — the real gate):
  · OK to let a 3rd-party SaaS hold a *read-only, bounded* role in account 064212132677
```

## Hard prerequisites / gotchas (read first)

1. **us-east-1.** The Console's CloudFormation stack MUST be created in `us-east-1`,
   even though our app runs in `ap-southeast-1`. Wrong region → delete + redo.
2. **Do NOT use the Console's default template.** Its default connect role is
   `AdministratorAccess` with no permissions boundary. In account 064212132677
   that is both a security non-starter AND literally un-creatable by a developer
   SSO principal (every role must be `boxlite-*` + carry the boundary, or creation
   is denied). Use OUR template: `iam-console-reader.cfn.yaml`.
3. **Custom role name may or may not be allowed.** Verify on the connect screen
   whether the Console lets you paste a custom role ARN. If it *hardcodes* the role
   name `SSTRole`, that's a non-`boxlite-*` name → a developer SSO principal cannot
   create it; an account admin would have to create it (still with the boundary).
   If it accepts a custom ARN, use `boxlite-sst-console-reader` from our template.
4. **Billing gate.** The free tier covers ≤350 active resources. dev alone is ~250
   resources → free. You will NOT be able to view *prod* stages without adding
   billing details (personal/dev stages stay free).
5. **Single GitHub org per workspace** (only relevant if you later enable Autodeploy).

## Steps (browser — Brian)

1. **Sign up** at https://console.sst.dev with your work identity; create a workspace
   (e.g. `boxlite`).
2. **Start the AWS connect flow** (Workspace settings → add an AWS account). It will
   show you:
     - the SST Console **AWS account id** it assumes *from*, and
     - a per-workspace **ExternalId**.
   Copy both. (These are the `SSTConsoleAccountId` and `SSTConsoleExternalId`
   parameters of our template.)
3. **Create the stack with OUR template, not theirs:**
   - Region: **us-east-1**.
   - Console → CloudFormation → Create stack → upload
     `docs/ops/sst-console/iam-console-reader.cfn.yaml`.
   - Fill `SSTConsoleAccountId`, `SSTConsoleExternalId`, and confirm
     `PermissionsBoundaryArn` matches the current boundary
     (`boxlite-role-boundary` as of 2026-06-22 — verify the name).
   - This requires creating a `boxlite-*` IAM role; if your SSO principal is denied,
     hand the template to an account admin (see gotcha #3).
4. **Point the Console at the role:** take the stack output `RoleArn`
   (`arn:aws:iam::064212132677:role/boxlite-sst-console-reader`) and finish the
   connect flow with it. If the Console only accepts its own template, see the
   "Fallback" section below.
5. **Wait for sync.** The dev stage's apps/resources should appear automatically
   (the Console reads the SST state + the role). Confirm you can see:
     - Resources view (Api / Proxy / SshGateway / Runner / DB / Redis …)
     - Logs (without opening CloudWatch)
     - Updates / deploy history (each deploy → what changed)

## Fallback if the Console refuses a custom template/role

The hosted connect flow may insist on deploying *its* template (default Admin role).
If so, the clean options are, in order of preference:
  1. After it creates `SSTRole`, **immediately attach our permissions boundary** and
     **replace the inline `AdministratorAccess`** with our read-only policy
     (an admin does this; the Console keeps working as long as the role keeps the
     permissions it actually uses — read-only is enough for visualization).
  2. If neither custom-ARN nor post-hoc scoping is possible, **do not connect.**
     Fall back to a self-hosted visualization (Grafana/CloudWatch dashboards) — see
     `docs/ops/sst-console/visualization-options.md`. Do NOT accept a standing
     `AdministratorAccess` role for a 3rd-party SaaS in this account.

## How to undo (clean teardown)

- Delete the CloudFormation stack in us-east-1 (removes `boxlite-sst-console-reader`).
- Remove the AWS account from the Console workspace.
- No app/infra change is involved, so there is nothing to revert in `apps/infra`.

## What you'll have after this

A live, read-only view of dev (resources, logs, deploy history) — the exact thing
that was missing while we hand-debugged LB/DNS drift. No deploy path changed, no
prod exposure, no standing high-privilege role.
