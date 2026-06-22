# Visualization options: SST Console (SaaS) vs self-hosted

The need: "see what the deploy changed + resource state + logs," so we stop
hand-debugging blind. Three realistic ways, from least to most "ours."

```
                     SST Console (SaaS)        CloudWatch Dashboards     Grafana (self-hosted)
─────────────────────────────────────────────────────────────────────────────────────────────
Who runs it          Anomaly Inc. (3rd party)   AWS (in our account)      us (in our account/ECS)
"What changed" diff   ★ best (per-deploy        ✗ not natively (you'd     ~ via annotations +
  per deploy            resource diff + perma-     build it from CFN/         CloudTrail panels (DIY)
                        link, zero setup)          CloudTrail events)
Logs                 ✓ built-in, no CloudWatch  ✓ native (it IS CW)       ✓ via CW datasource
Metrics/health       ✓                          ✓ native                  ✓ (CW/Prometheus)
Resource graph       ✓ (reads SST state)        ✗                         ~ DIY
Error "Issues"       ✓ (Node/containers)        ✗ (DIY alarms)            ~ (Loki/alerting DIY)
3rd-party role in    YES (read-only if scoped)  NO                        NO
  our AWS account
Cost                 free dev / ~$43/mo +prod   ~$3/dashboard/mo          EC2/ECS host (~$15-30/mo)
                                                                          + our maintenance time
Setup effort         ~10 min (browser connect)  low (define dashboards)   medium (deploy Grafana,
                                                                          wire CW datasource, build
                                                                          panels)
SST-state awareness  ★ native                   none                      none (it's infra metrics,
                                                                          not SST resource model)
"Fully ours"         ✗ (their SaaS)             ✓                         ✓
```

## Read this way

- **If the boss is OK with a scoped read-only 3rd-party role** → SST Console is the
  fastest path to the *exact* thing we missed (the per-deploy "what changed" view +
  resource model). 10 min, free for dev. **Recommended first.**
- **If "no 3rd party in the account" is a hard line** → there is **no self-hosted SST
  Console today** (not a shipped product). The honest "fully ours" answer is
  **CloudWatch Dashboards** (zero new infra, native) for metrics/logs, plus, if you
  want richer panels, **self-hosted Grafana** on ECS. Neither gives the SST
  *per-deploy resource diff* — that is uniquely the SST Console's value, because it
  reads the SST/Pulumi state. You'd approximate "what changed" by reading
  `sst diff` output + CloudTrail.

## Key honest point

The single feature that would have saved us this week — **"this deploy replaced these
6 LBs and deleted this DNS record"** — comes from the Console reading the **SST state
model**. CloudWatch/Grafana see *infrastructure metrics*, not the *SST resource graph*.
So:
- want that deploy-diff view + OK with a scoped role → SST Console.
- want fully-ours + can live without the SST-native deploy-diff → CloudWatch (+Grafana),
  and lean on `sst diff` / the SST CLI update output for "what changed."
