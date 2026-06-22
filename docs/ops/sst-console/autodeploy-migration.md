# SST Console Autodeploy — migration analysis (what can move, what can't, cost)

> Question: can we move our pipeline onto SST Console Autodeploy (git push →
> AWS CodeBuild → deploy), keeping OSS on GitHub?
> Short answer: **the cloud-deploy slice can; OSS cannot; runner should not (without
> care); tests don't need to.** And it's a net-add cost on a public repo. Details below.

## Current reality (verified against `main`, 2026-06-22)

```
main has NO cloud-deploy GitHub Action. Cloud deploy today = MANUAL:
    cd apps/infra && npm run deploy -- --stage dev      (local SSO creds)
What IS on main (.github/workflows):
    builds:  build-c / build-go / build-node / build-wheels / build-runtime / build-runner-binary
    tests:   lint / test / e2e-local / e2e-stack / codeql / api-client-drift
    misc:    config (reusable) / warm-caches
deploy.yml + runner-rollout.yml exist only on feature branches (feat/lite-deploy-button,
feat/deploy-boundary-fix) — NOT merged.
```

So "migrate the GitHub deploy to Console" is slightly mis-framed: there is no CI
deploy to migrate yet. The real choice for the **cloud deploy** is:
- **A. GitHub Actions** (our `deploy.yml`, uses OIDC role `boxlite-github-deployer-dev`), or
- **B. SST Console Autodeploy** (CodeBuild in our account).

## What maps where

```
Train / job            Can run on Console Autodeploy?   Recommendation
─────────────────────────────────────────────────────────────────────────────────
Cloud deploy (B)       ✅ yes (it IS sst deploy)         Either A or B; B adds a UI/history
Tests (lint/e2e/…)     ✅ technically (workflow runs      Keep on GitHub (free for public
                          any cmd) but no reason to        repo, already wired, PR gates)
Runner rollout (C)     ⚠️ technically via workflow, but   Keep separate/deliberate (stateful,
                          couples a dangerous stateful     kills boxes); don't bundle into a
                          swap to a push                   push-triggered deploy
OSS publish (A)        ❌ NO — PyPI/npm/crates trusted     Keep on GitHub Actions, always
                          publishing is bound to GitHub
                          Actions OIDC; CodeBuild loses it
                          → reverts to static tokens
                          (violates "secrets never in repo")
```

## Autodeploy config draft (sst.config.ts) — NOT activated

> This is a DRAFT for review. It is intentionally NOT added to the live
> `apps/infra/sst.config.ts` (would change deploy behavior). Verify the exact
> `target`/`workflow` callback API against current SST docs before using —
> the shape below follows sst.dev/blog/configure-autodeploy-workflow.

```ts
// inside $config({ console: { autodeploy: { ... } } })
console: {
  autodeploy: {
    // Map git events → stage. Our red line: dev is ONLY ever deployed from main.
    target(event) {
      if (event.type === "branch" && event.action === "pushed" && event.branch === "main") {
        return { stage: "dev" }
      }
      // prod is a DELIBERATE promotion (approval gate), never auto on push — omitted on purpose.
      // PR preview stages omitted on purpose: each PR stage = a full ~$530/mo-class infra
      // footprint; not worth it for this app.
    },
    // Take over the build so we run OUR wrapper (loads SSM env + Cloudflare creds),
    // not a bare `sst deploy`.
    async workflow({ $, event }) {
      await $`npm --prefix apps/infra ci`
      await $`npm --prefix apps/infra run deploy -- --stage dev`
      // Deliberately NOT here:
      //   · OSS publish  → GitHub Actions (trusted publishing needs GitHub OIDC)
      //   · runner roll  → separate, gated, version-pinned action (stateful, kills boxes)
      //   · tests        → GitHub Actions merge gates (free on public repo)
    },
  },
}
```

## IAM for Autodeploy (the part people miss)

Autodeploy's CodeBuild runs `sst deploy` → it needs the SAME IAM powers we fought
for: `iam:CreateRole` / `PassRole` / `PutRolePermissionsBoundary` on `boxlite-*`,
scoped by the `boxlite-role-boundary` condition. So:
- The boss's existing `boxlite-deploy-delegation` + `boxlite-bounded-role-admin`
  work does NOT go to waste — it must be granted to the **CodeBuild service role**
  (or the Console-managed role) instead of the GitHub OIDC role.
- This is additional IAM wiring + another role for the boss to bless. It does not
  remove the IAM problem; it relocates it.

## Cost (public repo makes this a net-add)

```
                       GitHub Actions (today)        SST Console Autodeploy
──────────────────────────────────────────────────────────────────────────────
CI/deploy compute      $0 (public repo = free runners)   AWS CodeBuild minutes (paid)
Console subscription   —                                  free ≤350 res; dev ~250 = free;
                                                          dev+prod ~500 → ~$43/mo; prod
                                                          stages need billing details
AWS infra              ~$530/mo per stage (unchanged either way)
──────────────────────────────────────────────────────────────────────────────
Net: Console autodeploy ADDS cost on a public repo. The payoff is the UI/history,
     not money saved.
```

## Recommendation

```
1. Visualization NOW (read-only, free) — see onboarding-runbook.md. Strong yes.
2. Cloud deploy via Console Autodeploy — a MEDIUM-TERM option, only if:
     (a) boss blesses the IAM (CodeBuild role gets the delegation), AND
     (b) team values the unified push-to-deploy + history enough to pay CodeBuild.
   Otherwise keep cloud deploy on GitHub Actions (deploy.yml) — same OIDC role,
   free runners.
3. OSS publish: never moves (trusted publishing).
4. Runner rollout: stays a deliberate, gated action; do not auto-couple to push.
```

> Bottom line: Autodeploy is a viable *deploy trigger + history* for the cloud
> train, but it is not a pipeline consolidation and not a cost win on a public repo.
> Adopt the **read-only Console for visibility first**; treat Autodeploy as a later,
> boss-gated decision.
