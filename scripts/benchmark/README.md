# Image startup baseline

`startup.py` measures a fixed workload through the local Python SDK, including
image preparation and VM startup. It runs four cases: cold/single, warm/single,
cold/batch, and warm/batch. This baseline does not enable OverlayBD or conversion.

## Run

Prepare the Python SDK and its native runtime before timing. Use a release SDK
or a fixed local build, and keep that build identical across comparisons. The
report records the installed SDK version and checkout commit; ensure that the
installed SDK actually corresponds to the checkout you intend to measure.

Choose a large image pinned by digest and a finite, representative command that
is already available in that image. Replace `ORG`, `IMAGE`, `DIGEST`, and the
workload below with real values; `DIGEST` must be 64 lowercase hexadecimal digits.

```sh
make test:perf:startup STARTUP_PYTHON=.venv/bin/python \
  STARTUP_ARGS='--image ghcr.io/ORG/IMAGE@sha256:DIGEST --output build/benchmarks/startup-run-1 --runs 20 --batch 4 --cpus 1 --memory-mib 512 --timeout 600 --interface eth0 --network-label dedicated-1Gbps -- python -m your_project.benchmark_workload'
```

Use a new output directory for each run; an existing directory is rejected.
`--runs` is the number of cold/warm pairs for each size (default 5).
`--batch` is the number of concurrently started boxes (default 4, range 2–64).
`--cpus` and `--memory-mib` set resources **per box** (defaults 1 and 512).
`--timeout` bounds each batch, including image preparation and startup.
`--network-label` records the network conditions; it does not configure them.

Compare the same image digest, command, architecture, SDK build, resources, and
network conditions. Keep other workloads off the host, allow memory for the whole
batch, and use the registry-facing interface. Omit it on macOS for a smoke run.

## Measurement boundaries

- **Cold/warm:** Each repeat and batch size gets a fresh, dedicated runtime home.
  Cold starts with empty BoxLite image/runtime caches. Boxes are removed after
  cold, and warm uses new boxes against the retained caches in the same runtime.
  Neither case clears the OS page cache or controls registry/CDN caches.
- **Task completion:** `task_complete_ms` runs from the shared batch start to
  command exit, including create and implicit VM startup. Success requires exit
  code zero. `batch_complete_ms` also includes draining stdout/stderr and reading
  SDK metrics for the whole batch. Guest output is
  discarded, and VM readiness alone does not count as workload completion.
  SDK import and runtime construction happen before the batch timer starts.
- **Image preparation:** `image_prepare_ms` comes from the SDK's
  `stage_image_prepare_ms`: image pull, rootfs preparation, and writable disk
  creation. It is not an isolated network download timer.
- **Network:** `host_rx_bytes` is the Linux interface RX-counter difference over
  the entire batch. It includes protocol overhead, guest traffic, and unrelated
  host traffic; it is not exact OCI payload bytes or a per-box download count.
  Linux requires an interface. macOS records `null` and is only a smoke check
  for this Linux baseline, not a comparable download measurement.
- **Disk:** `disk_before_bytes` / `disk_after_bytes` sum file `st_blocks * 512`
  inside the runtime home before startup and after workload completion, before
  removing boxes. Hard-linked inodes are counted once and symlinks are skipped.
  This includes caches and box state, excludes directories and external files,
  and does not establish unique physical usage of shared/reflink extents.
- **Conversion:** `conversion_ms: null` means not applicable to this baseline.
  It is not a measured conversion time of zero.

`results.json` contains configuration, host/SDK metadata, individual samples,
batch observations, and summaries. Median and nearest-rank P95 are calculated
independently for each cold/warm and single/batch combination. Small sample
counts give a coarse P95; retain individual samples and use enough repeats for
the decision being made. Batch task samples also share the same host load.

Any workload, measurement, or cleanup failure exits nonzero and marks the report
`failed`. Its summaries cover only completed batches, so do not treat a failed
run as a valid performance result. The active runtime home is retained on
failure for diagnosis; successful pairs remove their dedicated homes. Confirm
its boxes have stopped before manually removing a retained home.

Command arguments and configuration are stored in the report. Do not put
credentials in either. SDK exception text and guest output are not recorded by
the benchmark, but retained runtime homes can contain SDK diagnostic logs.

## Check the harness

```sh
make test:unit:startup
make lint:startup
make fmt:check:startup
```

Unit checks use standard-library fakes without VMs. An actual Linux workload run
supplies the baseline.

Preparation and workload measurements follow the structure of stargz-snapshotter's
[`run_task` (hello.py:181)](https://github.com/containerd/stargz-snapshotter/blob/main/script/benchmark/hello-bench/src/hello.py#L181)
and [`run` (hello.py:249)](https://github.com/containerd/stargz-snapshotter/blob/main/script/benchmark/hello-bench/src/hello.py#L249).
Only that measurement structure is borrowed; this harness uses BoxLite's SDK.
