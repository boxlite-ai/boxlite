# SST Console adoption — decision package

This folder is a self-contained package to decide + execute adopting the SST
Console (console.sst.dev) for BoxLite, **starting with read-only visualization**.

## Why we looked at this

We spent hours hand-debugging dev deploy drift (ghost LBs, orphan target groups,
api.dev DNS) with no view into "what does the deploy actually change." SST Console's
**Updates** (per-deploy resource diff), **Resources** view, and **Logs** are exactly
that missing view.

## The honest conclusion (one paragraph)

The SST *framework* (`sst deploy`) is, and stays, fully ours — deployment is never
locked to a vendor. The SST *Console* is a hosted SaaS; its open-source repo is
**source-available but not yet a supported self-host product** (official self-host is
"future"). So to use the Console today you use the hosted service. It's worth adopting
as a **read-only visualization layer** (free tier, scoped+bounded role). It is **not**
worth migrating the whole pipeline onto: it covers only the cloud-deploy slice, OSS
publishing must stay on GitHub (trusted publishing), it adds CodeBuild cost on our
free public-repo CI, and it needs the boss to bless a 3rd-party role in the account.

## Files

| File | What |
|------|------|
| `onboarding-runbook.md` | The browser steps Brian does to connect dev (read-only). |
| `iam-console-reader.cfn.yaml` | The scoped, `boxlite-*`+bounded, read-only connect role (replaces the Console's default Admin template). |
| `autodeploy-migration.md` | If we ever move cloud deploy to Console Autodeploy: what maps, the config draft, IAM, cost. |
| `boss-approval.md` | One-pager for the boss: what to approve + why it's safe. |
| `visualization-options.md` | SST Console (SaaS) vs self-hosted Grafana/CloudWatch — the "fully ours" alternative. |

## What's done vs what needs a human

```
✅ Done (in this repo, no AWS/credentials needed):
   · scoped read-only connect role (CloudFormation) — boxlite-*+bounded, avoids the
     account's iam:* boundary trap
   · onboarding runbook, autodeploy migration analysis, boss one-pager, viz comparison

🙋 Needs Brian (browser, ~10 min — cannot be automated; no CLI/MCP for Console setup):
   · sign up console.sst.dev, run the AWS connect flow with OUR template, connect dev

🙋 Needs the boss (one approval — the real gate):
   · OK to let console.sst.dev hold a read-only, bounded role in account 064212132677

⛔ Blocked tonight (SSO token expired while Brian slept):
   · could not live-verify anything against AWS; all artifacts are static/reviewed-by-reading
```

## Recommended sequence

1. Boss reads `boss-approval.md` → approves the read-only role (or says no → go to
   `visualization-options.md` for the self-hosted route).
2. Brian runs `onboarding-runbook.md` (≈10 min browser).
3. Team uses the read-only view for a couple weeks.
4. ONLY THEN decide whether cloud-deploy-via-Autodeploy is worth the cost + IAM work
   (`autodeploy-migration.md`). OSS + runner + tests stay where they are regardless.
