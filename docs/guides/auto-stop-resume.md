# AutoStop, AutoResume, and AutoDelete

The BoxLite cloud REST runtime can automatically stop a box after it becomes idle, and restart it on the next user operation. This reuses the existing `Stop` / `Start` lifecycle, does not create memory snapshots, and does not introduce a new `Paused` state.

> This guide describes the REST runtimes — the cloud, and `boxlite serve`, which sweeps on its own 30s tick. The embedded local runtime runs no sweeper; explicitly configuring these policies returns `Unsupported`, and the CLI refuses the two deadline flags before the request is made.

## Configuration

Lifecycle intervals are always in seconds:

| Field | Default | Disable Value | Meaning |
|---|---:|---:|---|
| `auto_stop` | `900` | `0` | Wait time before Stop after the last valid activity |
| `auto_delete` | `0` | `0` | Wait time before deletion after the box successfully stops |

You can set the policy when creating a box:

```json
{
  "image": "python:3.13",
  "auto_stop": 900,
  "auto_delete": 604800
}
```

Setting `auto_stop: 0` disables AutoStop; setting `auto_delete: 0` disables AutoDelete. When both are enabled, `auto_delete` must be greater than `auto_stop`.

The Python, Node.js, C, and Go SDKs can pass both fields at creation time. Box info returns the currently effective second-level values.

## Lifecycle Behavior

AutoStop behaves as follows:

1. The box is in `STARTED` and has no pending state transition.
2. The last valid activity is older than `auto_stop`.
3. The control plane submits `STOPPED` as the desired state and follows the normal Stop flow.
4. After the VM stops, the box enters the existing `STOPPED` state.

AutoResume behaves as follows:

1. The user issues an Exec, Files, or WebSocket attach operation against a stopped box.
2. The control plane submits or joins an existing Start operation.
3. The first request waits until the box actually reaches `STARTED` before forwarding to the runner.
4. If startup fails or times out, the request fails directly and is not forwarded to a box that is not yet ready.

The first request pays the cold-start latency. Multiple concurrent requests share the same state transition and wait on the same state event.

AutoDelete starts counting when the box successfully enters `STOPPED`. After the interval expires, the box is deleted and can no longer be recovered via AutoResume. Manual Stop also starts this timer; changing the policy to `0` cancels future automatic deletion.

## What Counts as Activity

| Operation | Refreshes Activity Time | Triggers AutoResume |
|---|---|---|
| Exec, execution status/signal/resize/kill | Yes | Yes |
| Files read/write | Yes | Yes |
| WebSocket attach | Only when real client data frames arrive | Yes |
| Metrics | No | No |
| Port preview and port proxy | No | No |

Metrics and port traffic are considered observability or external service traffic. Continuous metric scrapes, health checks, or traffic to exposed ports will not keep a box running indefinitely, nor will they automatically start a stopped box.

## What Is Preserved After Stop

AutoStop does not preserve runtime memory. After Stop:

- Persistent disk and mounted volumes are preserved;
- Memory, processes, and background tasks are not preserved;
- Terminal sessions and network connections are dropped;
- After AutoResume, the runtime environment is rebuilt from the image, persistent disk, and application startup logic.

Data that must survive Stop must be written to persistent disk or volumes. Do not rely on in-memory variables, background processes, or files that have not been flushed to disk.

## Billing Model

The purpose of AutoStop is to stop compute resources when idle. Billing still uses the platform's existing metered dimensions:

- CPU
- RAM
- GPU
- Disk

Running compute resources and persistent storage kept after Stop are different dimensions. Specific prices, free tiers, and billing rules depend on the deployment environment's billing page and commercial terms; this guide does not promise fixed pricing.

## FAQ

### Why does accessing Metrics not automatically start the box?

This is expected. Metrics are not considered user workload activity; otherwise monitoring systems would prevent AutoStop.

### Why did the port service stop?

Port proxies do not count as activity. If a service needs to stay running, disable AutoStop or manage the lifecycle through real Exec / Files / attach workflows.

### Will AutoResume restore the previous shell or process?

No. AutoResume is a Start, not a memory restore. Applications must be able to restart normally.

### Can AutoDelete be used after disabling AutoStop?

Yes. In that case AutoDelete will not actively stop a running box, but a manually stopped box will still be deleted according to `auto_delete`.
