# Why `sst deploy --stage dev` wants to replace LBs + churn DNS — root cause

> Static analysis (SSO expired overnight, so NOT live-verified — verification
> commands are at the bottom, run them when SSO is back). This both pins the
> long-hypothesized "env parity" cause to concrete variables AND corrects an
> earlier over-statement I made ("the deploy would break api.dev DNS").

## Correction first (I was too alarmist earlier)

Earlier I said the deploy "deletes the api.dev routing record without recreating →
breaks api.dev." That over-read the diff. The grounding facts:

- dev's deployed commit is **9e153f8b** (from the Api image asset tag). Its
  `sst.config.ts` DNS code is **identical to current main**: `serviceDomain('api')`
  for the Api LB + the `ApiCdn` Router for `dev.boxlite.ai` (verified via
  `git show 9e153f8b:apps/infra/sst.config.ts`).
- So the config has **not** changed api.dev routing since dev was deployed. The
  config does **not** remove api.dev by design.

Therefore the `ApiCNAMERecord` delete in the diff is **collateral of LB replacement**,
not a deliberate config removal. When the LB it points to is replaced, the record
churns with it (repoint/recreate), not a permanent removal. Whether a given deploy
leaves api.dev pointing correctly still needs a fresh `sst diff` to confirm — but
"the config would tear down api.dev DNS" was wrong.

## Real root cause: env parity → immutable LB property flip → forced replace

`sst.config.ts` references **79** env vars; the deploy wrapper injects **18** from
SSM (`/boxlite/<stage>/env/*`). The gap is the env-parity problem the team has
hypothesized for weeks. I pinned the part of the gap that actually forces LB
replacement:

```
ENV VAR (not in SSM 18)   sst.config.ts          drives
──────────────────────────────────────────────────────────────────────────────
JAEGER_PUBLIC             :316 envOr('JAEGER_PUBLIC','false')   Jaeger  LB public/internal
MAILDEV_PUBLIC            :777 envOr('MAILDEV_PUBLIC','false')  MailDev LB public/internal
PGADMIN_PUBLIC            :740 envOr('PGADMIN_PUBLIC','false')  PgAdmin LB public/internal
```

An ALB's **`internal` (internet-facing vs internal) flag is IMMUTABLE in AWS** —
changing it FORCES a replacement (delete + create), which cascades to its listeners,
target groups, and DNS records. So:

- If dev's Jaeger/MailDev/PgAdmin LBs were deployed **public** (some past deploy ran
  with `*_PUBLIC=true`), but the current deploy env omits those vars → they default
  to `false` (internal) → SST sees public→internal → **forces LB replacement** →
  listener/TG/DNS churn.

This is the mechanism behind the "replace every service LB + delete CNAME records"
destructive diff. It is **not** a code/config bug; it is **deploy-env ≠ deployed-env**.

## Why Api/Proxy/SshGateway/OtelCollector also showed in the replace set

Those don't have a `*_PUBLIC` flag, so the static cause is less certain — likely a
mix of (a) other env-driven properties (cert/domain via `STACK_DOMAIN` is in SSM, so
less likely), and (b) churn from prior PARTIAL deploys (the 5m34s run did partial LB
work, leaving state mid-transition). **This needs the live forcing-property from
`sst diff` to nail** (can't be determined statically). The Jaeger/MailDev/PgAdmin
`*_PUBLIC` flip is the one concrete, confirmable cause.

## Two fix paths (pick after live verification)

```
PATH A — match the env (avoid the replace; preserves current public LBs)
  1. Describe the live LBs, read each Scheme (internet-facing | internal).
  2. For any that are internet-facing, set the matching *_PUBLIC=true in SSM
     /boxlite/dev/env/ so the deploy env reproduces the deployed shape.
  3. Re-diff → the *_PUBLIC-driven replacements disappear.
  → Use if you want dev's current public observability LBs kept as-is.

PATH B — accept the replace (reconcile dev to the config's intended shape)
  The config INTENT is internal-by-default for Jaeger/MailDev/PgAdmin/Otel (their
  comments say internal; public is opt-in). dev being public is itself drift.
  Deploying makes them internal = correct end state. Brian already authorized a
  one-time destructive "overwrite". DNS for api.dev/proxy.dev repoints to the
  (new) Api/Proxy LBs as part of the replace.
  → Use if internal observability LBs are the desired target (likely yes).
```

Recommendation: **Path B** is probably right (internal observability LBs are the
intended design), BUT confirm with a fresh `sst diff` that the Api/Proxy *public*
LBs (the ones serving api.dev/proxy.dev) either stay or cleanly repoint — those must
NOT silently go internal (that WOULD break public access).

## Verification commands (run when SSO is restored)

```bash
aws sso login --profile boxlite-sso     # Brian, restore creds first

# 1. What scheme are the observability LBs actually in? (confirms the *_PUBLIC theory)
AWS_PROFILE=boxlite-sso aws elbv2 describe-load-balancers --region ap-southeast-1 \
  --query "LoadBalancers[?contains(LoadBalancerName,'Jaeger')||contains(LoadBalancerName,'MailDev')||contains(LoadBalancerName,'PgAdmin')||contains(LoadBalancerName,'Api')||contains(LoadBalancerName,'Proxy')].{Name:LoadBalancerName,Scheme:Scheme}" --output table

# 2. Fresh diff + the FORCING property per replaced LB (nails the non-*_PUBLIC ones)
cd apps/infra && AWS_PROFILE=boxlite-sso npm run sst -- diff --stage dev 2>&1 | tee /tmp/diff.log
# look for each LB's replace reason (idle of the diff shows changed immutable inputs)

# 3. If Path A: set the missing flags to match, e.g.
AWS_PROFILE=boxlite-sso aws ssm put-parameter --region ap-southeast-1 --type String \
  --name /boxlite/dev/env/JAEGER_PUBLIC --value true --overwrite   # only if LB is internet-facing
```

## The durable fix (beyond this incident)

Env parity is a recurring foot-gun (79 referenced, 18 in SSM). How the 18 got
chosen (verified): `seed-deploy-env-ssm.mjs` reads a LOCAL `.env`, parses key=val,
drops an EXCLUDE set + empty values, and seeds the rest to `/boxlite/<stage>/env/*`.
So "18" = whatever that one `.env` happened to contain. JAEGER_PUBLIC /
MAILDEV_PUBLIC / PGADMIN_PUBLIC weren't in it → never seeded → deploy defaults them
to `false`. The right durable fix is one of:
- **Seed ALL infra-affecting env into SSM**: add JAEGER_PUBLIC / MAILDEV_PUBLIC /
  PGADMIN_PUBLIC (+ any other infra-driving var) to the seed `.env` with dev's REAL
  values, and re-run the seed — so any deploy (laptop / CI / Console) reproduces the
  same resource shape. (Values need a one-time read of dev's live LB schemes — SSO.)
- **OR remove env-driven immutable infra props from the hot path** — make
  Jaeger/MailDev/PgAdmin `public` a committed config constant, not an env toggle, so a
  missing env var can never silently flip an LB's scheme. (Trade-off: loses the
  documented public-opt-in toggle; aligns with the config's internal-by-default intent.)

Either kills the "deploy from a different machine = destructive diff" class of bug.
