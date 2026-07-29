# Usage accounting and billing boundary

BoxLite's usage ledger follows Daytona v0.190.0's open-source
`UsageService` lifecycle semantics, with `sandbox` renamed to `box`.
The reference implementation is
[Daytona `usage.service.ts` at commit `01c502b`](https://github.com/daytonaio/daytona/blob/01c502bb1f1ff8f2885d0cd490e043736083dca8/apps/api/src/usage/services/usage.service.ts).
That commit is the source shipped with [Daytona v0.190.0](https://github.com/daytonaio/daytona/releases/tag/v0.190.0).

## Data flow

```text
Box state / desired-state events
             |
             v
        UsageService
             |
             +--> box_usage_periods         (open and newly closed periods)
             |
             +--> box_usage_periods_archive (closed-period archive)
                         |
                         v
                 UsageQueryService
                         |
                         +--> /organization/:organizationId/box/:boxId/usage
                         +--> /organization/:organizationId/usage/aggregated
                         +--> /organization/:organizationId/usage/box
                         +--> /organization/:organizationId/usage/chart
```

The dashboard uses these built-in endpoints through the normal API URL
when `ANALYTICS_API_URL` is empty. Setting `ANALYTICS_API_URL` switches
the generated analytics client to that external service instead.
Both paths use the caller's Bearer token.

## Metering rules

| Box transition                                 | Ledger action                                                                      |
| ---------------------------------------------- | ---------------------------------------------------------------------------------- |
| `STARTED`                                      | Atomically close the previous period and open a CPU/GPU/RAM/disk period            |
| `STOPPING`                                     | Atomically close the previous period and open a disk-only period                   |
| `STOPPED`                                      | Repair a skipped `STOPPING` transition or a stopped-box disk resize                |
| `STARTING`                                     | Preserve an existing disk-only period                                              |
| `RESIZING`                                     | Preserve the current allocation until the resulting `STARTED`/`STOPPED` transition |
| `ERROR`, `ARCHIVED`, `DESTROYING`, `DESTROYED` | Close the open period                                                              |
| desired state `DESTROYED`                      | Close the open period immediately                                                  |
| open for more than 24 hours                    | Close and reopen at the same timestamp                                             |

Closed periods are moved to the archive in batches. A startup and
minute-level reconciler opens a period for existing billable boxes that
do not yet have one and closes orphaned periods or periods whose boxes
are explicitly terminal. It also replaces an open period when its
organization, region, resource, class, or rating dimensions no longer
match the current box. It starts at reconciliation time and does not
invent historical usage.

Usage ranges are half-open (`[from, to)`). Open periods are evaluated at
a fixed query-start timestamp. Aggregates are resource-seconds:

```text
resource_seconds = allocated_resource * overlapping_duration_seconds
```

## Billing service integration

Daytona's open-source API records allocation periods but does not
contain the monetary rating, wallet, tax, invoice, or payment service.
Its dashboard connects directly to separately configured analytics and
billing URLs. BoxLite keeps the same boundary:

- `ANALYTICS_API_URL` is optional; empty uses the built-in raw usage API.
- `BILLING_API_URL` points to the external monetary billing service.
- The billing client contract includes
  `GET /organization/:organizationId/usage` and
  `GET /organization/:organizationId/usage/past?periods=...`, plus the
  existing wallet, tier, invoice, and payment routes.
- The external billing service must consume the active and archived
  ledger (directly or through an operator-owned export), apply its own
  versioned rate card, and return the billing-client response models.

The built-in analytics response keeps the existing Daytona-compatible
price fields, but returns `0` for them. This is deliberate: a raw
allocation ledger cannot safely infer currency, regional/GPU rates,
discounts, taxes, credits, or invoice state. The dashboard labels this
mode `Not rated` and hides price totals and columns.

[Daytona's current public billing documentation](https://www.daytona.io/docs/billing)
now bills `CREATING`, `STARTING`, and `STOPPING` as full-resource states until
the box stops. This implementation intentionally uses v0.190.0's
disk-only-at-`STOPPING` source semantics because that is the auditable
open-source service and generated client version aligned with this
codebase.
