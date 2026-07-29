# Organization Limits and Usage

The BoxLite cloud REST runtime meters what an organization consumes and refuses work that would push it past a ceiling. There are three independent layers:

| Layer | Scope | Enforced when |
|---|---|---|
| [Organization quota](#organization-quota) | Summed across the whole organization | Creating or starting a box; creating a volume |
| [Per-box limits](#per-box-limits) | A single box | Creating a box |
| [Rate limits](#rate-limits) | API requests | Every request |

> This guide describes the cloud REST runtime. The embedded local runtime has no organization model and does not apply quotas.

## Current usage

`GET /organizations/{organizationId}/usage` returns live consumption paired with each ceiling:

```json
{
  "currentCpuUsage": 12,   "totalCpuQuota": 64,
  "currentMemoryUsage": 48, "totalMemoryQuota": 256,
  "currentDiskUsage": 300,  "totalDiskQuota": 512,
  "currentGpuUsage": 0,     "totalGpuQuota": 0,
  "currentBoxUsage": 3,     "maxConcurrentBoxes": 50,
  "currentVolumeUsage": 4,  "maxVolumes": 100
}
```

The `current*` figures include reservations held for boxes that are still being created, so they match the numbers the quota check enforces against rather than lagging behind them.

## Organization quota

Six ceilings apply to the organization as a whole. Unlike upstream Daytona there is no per-region or per-box-class breakdown — one row covers every region.

| Ceiling | Default | Unit | Meaning |
|---|---:|---|---|
| `totalCpuQuota` | `64` | vCPU | Summed across boxes consuming compute |
| `totalMemoryQuota` | `256` | GB | Summed across boxes consuming compute |
| `totalDiskQuota` | `512` | GB | Summed across boxes occupying disk |
| `totalGpuQuota` | `0` | GPU | `0` refuses GPU boxes outright |
| `maxConcurrentBoxes` | `50` | boxes | Boxes consuming compute at once |
| `maxVolumes` | `100` | volumes | Volumes occupying object storage |

A ceiling of `0` denies that dimension entirely — a 2 vCPU box does not fit in a 0 vCPU quota. An organization with no quota row uses the defaults above; it is never treated as "no access".

### Administering quotas

Quotas are managed through the admin API and require the `admin` system role:

```http
GET   /admin/organizations/{organizationId}/quota
PATCH /admin/organizations/{organizationId}/quota
```

`PATCH` is partial — send only the ceilings you are changing and the rest keep their current values. For an organization still on the built-in defaults the patch is layered onto those defaults and a row is created. Changes take effect on the next box or volume create; nothing is cached.

The `customized` field on the response distinguishes an organization whose quota was explicitly set from one that merely happens to match the defaults.

## What counts toward quota

A box charges compute (vCPU, memory, GPU, and one slot against `maxConcurrentBoxes`) while it is running or transitioning, and disk for as long as its image is still on a runner:

| Box state | vCPU / Memory / GPU / Slot | Disk |
|---|:--:|:--:|
| `creating`, `restoring`, `starting`, `started`, `stopping`, `unknown` | ✅ | ✅ |
| `stopped` | ❌ | ✅ |
| `archiving` | ❌ | ✅ |
| `archived` | ❌ | ❌ |
| `destroying`, `destroyed`, `error` | ❌ | ❌ |

Stopping a box therefore frees its compute and its concurrency slot but keeps charging disk — archiving moves the disk to cold storage and frees that too. This is the same accounting [AutoPause](./auto-pause-resume.md) relies on.

A volume counts against `maxVolumes` for as long as it occupies storage:

| Volume state | Counts |
|---|:--:|
| `pending_create`, `creating`, `ready`, `pending_delete`, `deleting` | ✅ |
| `deleted`, `error` | ❌ |

## Per-box limits

Independent of the organization total, a single box cannot exceed the organization's per-box ceilings. These are checked when the box is created, so an out-of-range request is refused rather than silently stored.

| Field | Default | Unit |
|---|---:|---|
| `max_cpu_per_box` | `4` | vCPU |
| `max_memory_per_box` | `8` | GB |
| `max_disk_per_box` | `10` | GB |

A value of `0` or below means "unset" and is not enforced.

## Rate limits

Five throttler scopes exist. Each is active only when its limit and window are configured — a scope with no configuration is not registered, so nothing is throttled under it.

| Throttler | Applies to |
|---|---|
| `anonymous` | Unauthenticated requests to public routes |
| `failed-auth` | Repeated authentication failures |
| `authenticated` | All authenticated requests, tracked per organization |
| `box-create` | Box creation, on routes that opt in |
| `box-lifecycle` | Box start/stop/delete, on routes that opt in |

`authenticated`, `box-create` and `box-lifecycle` accept per-organization overrides (`authenticatedRateLimit`, `boxCreateRateLimit`, `boxLifecycleRateLimit`, each with a matching `…TtlSeconds`), falling back to the deployment-wide configuration.

Responses carry the remaining budget, with the throttler name as a suffix:

| Header | Description |
|---|---|
| `X-RateLimit-Limit-{throttler}` | Requests allowed in the window |
| `X-RateLimit-Remaining-{throttler}` | Requests left in the current window |
| `X-RateLimit-Reset-{throttler}` | Seconds until the window resets |
| `Retry-After-{throttler}` | Seconds to wait; sent once the limit is exceeded |

## Usage metering

Quota enforcement answers "may this run now"; metering records what actually ran, for billing.

Every box lifecycle transition opens or closes a usage period capturing the box's cpu, gpu, memory, disk, region and class over a time span. A stopped box keeps an open period charging disk only. Open periods are closed and reopened daily so no single period spans more than a day, and closed periods are moved to an archive table to keep the active one small.

Metered dimensions are cpu, gpu, memory and disk. Prices, free tiers and commercial terms depend on the deployment and are not defined here.

Where the deployment configures a collector endpoint, organizations that opt into telemetry additionally get their usage and ceilings exported once a minute as `boxlite.box.used_*` and `boxlite.box.total_*` OTLP gauges, tagged with the organization id.
