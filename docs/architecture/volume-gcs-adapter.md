# Volume mounts on GCS (keeping S3 compatibility)

**Landed as** the commits in `783609f2..cf29f31e`; see
[PR #1468](https://github.com/boxlite-ai/boxlite/pull/1468).
Every `file:line` below was read off the tree at `cf29f31e`.
**Annotation convention**: [measured] run on a real host; [documented] quoted from
official documentation; [unverified] neither.

Tracked internally as POL-553, not linked here because this repository is public and the
tracker is not. A full AWS→GCP storage assessment exists as a separate document that is
likewise not in the repository. This document covers only the host-side volume mount.
`getPushAccess` and its per-org STS credentials are a different path and out of scope.

> **Target environment is undecided.** The GCP project originally provisioned for
> verification (dev2) was deliberately deleted. Nothing here depends on it, but the three
> acceptance criteria — create a volume from the dashboard, then create a box that mounts
> it — have to be redone in a new environment.

---

## 1. Design

One backend switch, **defaulting to `s3`**. Compatibility rests on the default value, not
on conditionals at the call sites.

```
config.go   + VolumeStorageBackend  envconfig:"VOLUME_STORAGE_BACKEND" default:"s3" validate:"oneof=s3 gcs"
client.go   + volumeBackend string
volumes.go    getMountCmd split into backend selection / argv / systemd wrapper
```

`getMountCmd` previously mixed three jobs in one function: building the argv, building the
credential environment, and wrapping in systemd. It is now split by backend
(`volumes.go:398`):

```go
type mountSpec struct{ bin string; args, env []string }

func (c *Client) getMountCmd(ctx context.Context, volume, path string) *exec.Cmd {
    if c.volumeBackend == volumeBackendGCS {
        return c.wrapMountCmd(ctx, gcsfuseMountSpec(volume, path))
    }
    return c.wrapMountCmd(ctx, c.mountS3Spec(volume, path))
}
```

- `mountS3Spec` (`volumes.go:408`) — the existing argv and the four conditional `AWS_*`
  injections, moved verbatim. No behaviour change.
- `gcsfuseMountSpec` (`volumes.go:449`) — empty env. On GCE, credentials resolve through
  ADC and the metadata server, exactly the shape the runner already relies on with the EC2
  instance role and no injected secrets [documented].
- `wrapMountCmd` (`volumes.go:475`) — shares the existing systemd branch and IO
  redirection, and is where the spec's environment is attached: once, after the
  branch, so the mount tool sees the same thing whether or not systemd wraps it.

Five changes were required:

| Change | Why |
|---|---|
| `systemd-run --scope` **kept for both backends**, with the credentials passed as the command's environment rather than on its argv | [measured] A FUSE daemon started directly lands in the service's own cgroup; after `systemctl restart` the mount is gone and the data unreadable. Under `--scope` it lands in its own transient scope and survives. Note the deadline kill reaches only the foreground process — a daemon that has already forked is cleaned up by the umount on the failure path |
| `exec.Command` → `exec.CommandContext`, plus `volumeMountTimeout` (`volumes.go:32`, 90s) | [measured] gcsfuse defaults `MaxRetryAttempts` to the int64 maximum, i.e. retry forever. `Create` receives gin's request context, which carries **no deadline** (`box.go:49`; `server.go` sets no read/write timeout), so the context alone cannot bound this and the path needs a limit of its own |
| `volumeProbeTimeout` (`:36`, 10s) and `volumeReadyTimeout` (`:42`, 30s) | On a wedged FUSE mount, `stat`, `umount` and `mountpoint` all block indefinitely. The readiness loop became a single overall deadline rather than "attempts × per-attempt timeout", which in the worst case would hold the per-volume mutex for hundreds of seconds |
| `isDirectoryMounted` returns `(bool, error)` (`:262`) | "Could not probe" and "not mounted" previously shared one `false`. Callers use it to decide whether to mount and whether a mount is theirs to tear down, so a false negative means **mounting over a live mount** or **unmounting someone else's** |
| `cleanUpFailedMount` (`:221`) runs on an **independent** context derived by `cleanupContext` (`:204`) | Both things that trigger cleanup — the timeout firing and the client disconnecting — leave the caller's context cancelled, and exec returns immediately without running under a cancelled context. Cleanup would disable itself in the only situation it exists for |

## 2. Flag mapping

[measured] gcsfuse 3.8.4. mount-s3's `--allow-other` and `--allow-delete` are rejected by
gcsfuse as `unknown flag`.

| mount-s3 (`mountS3Spec`, `volumes.go:408`) | gcsfuse | Notes |
|---|---|---|
| `--allow-other` | `-o allow_other` | Both `-o` and `--o` are accepted; `-o` is the documented spelling |
| `--file-mode 0666` `--dir-mode 0777` | same names, same values | Takes octal as a string; defaults are `0644`/`0755`. Both backends share the constants `volumeFileMode` and `volumeDirMode` (`volumes.go:385`) |
| `--allow-delete` `--allow-overwrite` | dropped | gcsfuse permits both by default |
| — | `--implicit-dirs` | **Newly required**: on a flat bucket a directory that exists only as an object-name prefix is otherwise invisible |
| — | `--metadata-cache-ttl-secs` | **Must be set explicitly**; see §4 |
| `<bucket> <path>` | same | Positional arguments match |

## 3. Everything else that changed

| Where | Change |
|---|---|
| `volume.manager.ts:36`, `:47`, `:175`, `:216` | Extracted a `VolumeBucketStore{create,destroy}` interface with two implementations. The S3 one moves the existing `CreateBucket` + `PutBucketTagging` + `deleteS3Bucket` in unchanged; the GCS one uses `@google-cloud/storage`'s `createBucket` / `setLabels` / `deleteFiles({force:true})` + `delete` |
| `volume-bucket.store.ts:182`, the create options | GCS buckets **enable soft delete by default with seven-day retention**; S3 has no equivalent. Without turning it off, a volume the user deleted stays recoverable and billable while the state machine already reports `DELETED`. Set at create time as `softDeletePolicy.retentionDurationSeconds: '0'` [documented: 0 is the disable value; every other accepted value is 7 to 90 days] |
| `volume.entity.ts:48` `getBucketName()` | **Unchanged** — one volume is still one bucket |
| `volume.service.ts:52` | Uses the shared predicate `isVolumeStorageConfigured` (`volume-bucket.store.ts:43`). It previously tested `s3.endpoint` itself, so a GCS-only deployment would 503 at the request boundary and never reach the rest |
| `apps/infra/**` | **Unchanged**. See the boundary note below |
| `volumes_test.go`, `volume-bucket.store.spec.ts` (neither existed) | **New**, 13 Go test functions + 28 spec cases |

**Boundary: `apps/infra` is untouched, so no deployment this repository builds can select
the gcs backend.** That stack provisions AWS EC2 runners, which run the s3 backend;
installing gcsfuse into its AMI or wiring a GCS-only variable into its systemd unit would
ship configuration those hosts can never use. A gcs-capable host is provisioned by Pulumi
outside this repository. This is a boundary judgement rather than an omission, and it can
be overruled: if the repository should produce gcs hosts itself, the right place is a GCP
stack under `apps/infra`, not gcsfuse in the EC2 user-data.

Minimum IAM on the runner side, for reference when setting up a new environment:
`roles/storage.objectUser` plus `roles/storage.legacyBucketReader`, conditioned on
`resource.name.startsWith("projects/_/buckets/boxlite-volume-")`. The first does not carry
`storage.buckets.get`, and every gcsfuse mount issues `GetStorageLayout`, which is what the
second covers. `bucketViewer` covers it too, but beside `objectUser` it also adds
`storage.buckets.list`, where the legacy role adds nothing else.

Using the native GCS client removed two expected obstacles: labels map onto what
`PutBucketTagging` carried, and `deleteFiles` needs no `ListObjectVersions` equivalent.

**Bucket granularity**: keeping one bucket per volume is the price of a minimal change. GCS
bucket creation is rate-limited per project [unverified], which volume creation in bulk
would hit. A single bucket with per-volume prefixes is the better end state, but it touches
the entity, IAM and the API. The suggestion is to ship this and monitor bucket-creation
failures.

## 4. Risks

### The one true regression: the consistency default

| | Default behaviour |
|---|---|
| mount-s3 1.20 | `--metadata-ttl` defaults to `minimal`, i.e. **strong read-after-write consistency** [documented] |
| gcsfuse 3.8 | `--metadata-cache-ttl-secs` defaults to **60** [measured], i.e. up to 60 seconds stale |

`mountS3Spec` (`volumes.go:408`) does **not** set `--metadata-ttl` today, so it gets strong
consistency. Switching to gcsfuse would default to a 60-second staleness window. Setting
`0` recovers strong consistency at the cost of the request reduction the cache would give.
**That is a trade-off, and it has to be stated in the argv rather than inherited.**

### Semantic changes (mostly improvements)

| Operation | mount-s3 1.20 [documented] | gcsfuse 3.8 [documented] |
|---|---|---|
| Random writes | Unsupported; a write after seek fails outright | Supported (read-modify-write of the whole object) |
| Overwriting an existing object | Needs `--allow-overwrite` **and `O_TRUNC`** | Allowed by default |
| File rename | Unsupported on general-purpose buckets | Supported (copy + delete) |
| **Directory rename** | Unsupported on any bucket | **Also unsupported on a flat bucket** [measured against real GCS] — `--rename-dir-limit` defaults to `0`, and the failure reports `Too many open files` (EMFILE), a badly misleading errno. Bucket-type decision in §4.1 |
| Hard links / file locks | Unsupported | Also unsupported (a draw) |

**"Possible" is not "fast"**: the operations mount-s3 refuses outright, gcsfuse emulates —
a random write is a whole-object round trip, a directory rename is a per-object copy and
delete. Workloads that used to fail will now succeed, but possibly slowly, and **the
request count goes straight onto the bill**. Performance on both sides is [unverified].

### Concurrent writes: the failure mode changed, and the window is narrow

[documented] `multiple writers can modify different objects in the same bucket
simultaneously without any issue`; ESTALE is strictly **per object**, and only **across
mount points** (behaviour `from the same mount` matches a local filesystem).

A volume is mounted once per runner (`volumes.go:71`'s `fuseMountedVolumes` dedupe plus the
per-volume mutex at `:140`), and every box on that runner shares one gcsfuse process. So
ESTALE needs **all** of: the same volume, boxes landing on **different runners**, and
writes to **the same file**.

Against mount-s3: concurrent writes to one object across mount points `may have unexpected
results` [documented], with no error. So this trades **silent corruption** for an
**explicit error**, which is more diagnosable.

**The one thing that is not per-object**: deleting an empty directory is list-then-delete
and not atomic [documented] — an `rmdir` on mount point A races a file creation in that
directory on mount point B. This does not exist on mount-s3, which never persists empty
directories at all. Hierarchical namespace only makes folder renames atomic.

There is **no volume exclusivity check anywhere in the code** (no hits across
`apps/api/src/box` or `apps/runner/pkg`), so one volume can be mounted by boxes on several
runners. That is already a hazard on mount-s3 today; it simply does not report an error.

### Cases the documentation advises against [documented]

Not POSIX-compliant; not recommended for source repositories (which depend on file locks),
databases, large numbers of concurrent small files, or large-scale listing. A volume *is* a
box's working directory, and users run git and compilers in it — **all three can apply**.
This is an improvement over mount-s3, but it should not be read as a filesystem guarantee.

Also: buckets with a retention policy cannot be written, and objects with
`content-encoding: gzip` behave unpredictably.

### The local development stack breaks

[measured] gcsfuse **3.8.4 and 2.12.2** both issue a **gRPC** call to
`projects/_/buckets/<b>/storageLayout` at mount time (`EnableHns` is on by default).
fake-gcs-server returns 404 on the HTTP/2 preface, and it only offers
`-scheme http|https|both` with no gRPC. **infra-local cannot back gcsfuse with
fake-gcs-server.**

What local development actually wants is a directory, not object storage.
`getVolumeMountBasePath()` (`volumes.go:61`) already branches on `development`; a dev
directory backend that skips FUSE and binds directly belongs on that same branch.

## 4.1 Bucket type: use a flat bucket, not hierarchical namespace

[measured: two real GCS buckets side by side, plus the Cloud Billing Catalog API]

**Price** (Regional / asia-southeast1):

| | Flat bucket | HNS | Delta |
|---|---|---|---|
| Standard storage | $0.020 / GiB·month | $0.020 / GiB·month | **none** |
| Class A | $5.0e-06 / op | $6.5e-06 / op | **+30%** |
| Class B | $4.0e-07 / op | $5.0e-07 / op | **+25%** |

All 36 HNS SKUs sit in the `Ops` group; storage is unaffected.

**Capability** (the same production argv against both real buckets):

| | Flat bucket | HNS bucket |
|---|---|---|
| Mount / `--implicit-dirs` / `--only-dir` isolation / read-write | ✅ | ✅ |
| File rename | ✅ | ✅ |
| **Directory rename** | ❌ `Too many open files` | ✅ 2.4s |

**Decision: flat bucket.** Losing directory rename is **not a regression** — mount-s3 does
not support it today either, so users lose nothing. The 30% Class A premium is a certain
cost, while the value of directory rename is unquantified.

The price of that choice: **HNS can only be enabled at bucket creation and cannot be
switched on later**, so changing course means recreating buckets and migrating data. That
cost is at its lowest right now, with no volume buckets created yet.

HNS also drops support for [documented]: object versioning, bucket lock, object holds and
retention lock, object-level ACLs, and cross-bucket replication; folders nest at most 50
deep. Object versioning is irrelevant here — volume buckets have never had versioning
enabled, which is why `destroy()` passes no `versions`.

## 5. Traps

When porting between object-storage backends, every mistake below **compiles and passes
unit tests**. Each one corresponds to a pattern that is easy to repeat in this kind of
adaptation.

| Trap | Pattern |
|---|---|
| `probe()` using `getProjectId()`: with `GCS_PROJECT_ID` set it returns the cached option in 0ms without touching credentials — a no-op | The code did not do what its comment claimed. Use `authClient.getAccessToken()` instead (measured: a real token in 450ms with ADC present, rejection when ADC is broken) |
| The `s3.endpoint` gate in `volume.service.ts` left unchanged, so a GCS-only deployment 503s at the request boundary | One rule written in two places, with only one updated. The fix is to extract a shared predicate, not to patch the second copy |
| `os.Stat` and `os.ReadDir` in `waitForMountReady` left unbounded | Same shape as above: `volumeMountTimeout` only covers the mount command itself |
| `deleteFiles({force:true})` rejects with an `Error[]`, so `error.code` is `undefined`, neither the 404 nor the 409 branch is taken, the bucket is not deleted and `errorReason` is empty | Assuming a rejection shape without reading the library source |
| Cleanup bound to the caller's context — while the timeout or disconnect that triggers cleanup is exactly what leaves that context cancelled, so cleanup disables itself | Cleanup must not inherit the cancellation that triggered it |
| Three tests that **could not fail for the reason they named**: asserting a mock was called, asserting an exit code that always holds on an ordinary directory, and depending on a binary the host happened to have | Tests built on the same assumptions as the code; green is then self-certification |
| A whitespace string `GCS_LOCATION='   '` slipping past a `!location` guard | The repository already has a `?.trim()` convention (15 sites in `configuration.ts`, pinned in `billing-api-config.spec.ts` with `it.each([undefined,'   '])`) that this did not follow |
| Bucket creation not disabling soft delete, so GCS retains for seven days and a deleted volume stays recoverable and billable | Mapping only the source backend's explicit settings one by one, without asking which settings the *target* backend turns **on by default** that the source does not have. The difference is not in the fields both sides write; it is in the defaults only one side has |
| Asking for those settings and then discarding the response, so a policy the service ignored read exactly like one it applied | A 2xx answers "the call succeeded", not "the request was honoured". Where a setting is silently ignorable, the only proof is the metadata the create returns — and the cost of not reading it lands weeks later, on a bill or on data a user believed deleted |

## 6. Unverified

[already done] Mounting against real GCS, daemonisation, `--implicit-dirs`, `--only-dir`
tenant isolation, writes, and both file and directory rename — see §2 and §4.1; plus a
mount-s3 1.20.0 regression against MinIO at the argv layer and through the real code path.

Still missing:

1. ~~**The last hop**: gcsfuse → virtiofs → reads and writes inside a box.~~ [measured] Done
   on a GCP dev stage: a file written from inside a box arrived in the volume bucket as an
   object. The runner mounted with the instance service account and no injected credential,
   which is the credential shape §1 assumes.
2. ~~**Minimum IAM role**: whether the bucket-level half can be dropped.~~ [measured] It
   cannot. `objectUser` carries no `storage.buckets.get`, and neither does `objectViewer`
   or `objectAdmin`; a mount granted object access alone fails at `GetStorageLayout`
   before reading a byte. The pair named above is the floor, and it is the pair that was
   mounted — `legacyBucketReader`, not `bucketViewer`, which was never attached.

   Both were measured with grants attached to one bucket by hand, not through a deploy, so
   what is established is the runtime behaviour rather than the stack that should produce it.
3. Performance on both sides (latency, and the composition of the request count) — the one
   dimension where GCS cost could get away from us.
4. The exact per-project rate limit on GCS bucket creation and deletion, which decides how
   far one-bucket-per-volume scales.
5. What `volumeMountTimeout` actually does when it fires (mount-s3 does not retry forever
   the way gcsfuse does, so this was not reproducible locally).
6. **Whether GCS ever normalises a bucket location by more than case.** `create` now
   compares the location the service reports against the one it asked for, and deletes the
   bucket when they disagree — so if the service ever answered a requested `us-east5` with
   anything but a case variant of it, a correctly created bucket would be destroyed. One
   `buckets.insert` against a real project answered `"US-EAST5"`, and the documented
   location forms differ from their requested spelling only in case, but a single
   observation is not the same as a rule. This is the only entry in this list whose
   violation is destructive rather than a matter of cost, access or speed.
