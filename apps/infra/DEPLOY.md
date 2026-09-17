# Deploying BoxLite

Three tools, three config files, two clouds, one description of the stack.

This sits beside the incumbent `sst.config.ts` / `deployment/sst.ts` rather than
replacing it. Both describe the same app and the same stage, and every module
keeps the incumbent's logical resource names — so the new path adopts the
existing state instead of building a second set beside it. That is what makes
the cutover a diff to read rather than a migration to perform:

```
npm run mdeploy -- --stage dev --diff
```

## The shape

```
apps/infra/
  mstage/                  shared: sign-in, stage coordinates, the config store, state repair
  mbuild/                  shared: build, publish, promote and verify images
  mdeploy/                 BoxLite's stack, and the two engines that apply it
    sst.config.ts          AWS: the modules, composed for SST
    pulumi/program.ts      GCP: the same modules, composed for Pulumi
    globals.d.ts           what both engines inject, declared so tsc can see it
    src/deploy.ts          which engine — resolved once, from one field
    src/stack-env.ts       what one deploy reads out of the environment, for both engines
    src/api-environment.ts what the control plane container reads
    stack/                 what each module needs, described without a cloud
    stack/providers/aws/   how AWS answers it
    stack/providers/gcp/   how GCP answers it
  mstage.config.json       which stages exist, where they live, and what the store may hand out
  mbuild.config.json       what to build, and which repository receives it
  mdeploy.config.json      what shape to deploy into
```

`mstage` and `mbuild` know nothing about BoxLite. They are the same code
`boxlite-backoffice` runs, with a different JSON file beside them. `mdeploy` is
the outlier, and not because its code is repository-specific: its contracts name
no cloud and no application, and what belongs to BoxLite is the *set* of modules
— that there is a control plane, a box proxy, a collector and a fleet of hosts
with nested virtualization.

## Which file holds what

A value belongs in `mdeploy.config.json` when changing it changes the
infrastructure, and in `mstage.config.json` when changing it changes what a
running thing reads. `STACK_DOMAIN` is a store value: moving a stage to another
domain changes no resource shape. `DASHBOARD_DOMAIN` is the same kind of value
and the same key with a narrower reach — it moves where the dashboard is served
and leaves the control plane on `api.<STACK_DOMAIN>`, which is the name a runner
is handed at first boot and the only name the in-VPC private zone answers for.
A stage that names neither serves both from one domain. The dashboard's host is
also the one Auth0 has to hold: it matches a `redirect_uri` exactly, so the
callback and logout URLs name that host and not the stage domain —
`npm run bootstrap -- --provision-auth0` registers them from these same two
keys, and Auth0 has no upsert to repair them with afterwards. `runners.size` is `mdeploy`'s: it decides
which machine family a host is created from, and on GCP whether nested
virtualization is available at all.

Neither file holds a secret, and neither holds anything one deploy decides — an
image tag comes from the invocation, because it is different every time.

The stage file is the one a runner cannot have: it names an account, so it is not
committed, and every tool reads a file rather than a variable. `mstage config
put` carries one stage's block into the GitHub environment of the same name, and
`.github/actions/setup-infra` is the other end — it asks `mstage config get` for
each stage the job names and merges the answers back into `.mstage.config.json`,
so a stage nobody has `put` is refused in setup, by name, rather than minutes
later by whichever tool read for it first. `boxlite-backoffice` restores it the
same way, with the same action. A promotion needs two declarations and restores
both out of the destination's environment: a job is bound to one environment,
and it is not the source's.

The runner binary is the one case worth spelling out, because it is in neither
file. Its version belongs to the *commit*: the workspace `Cargo.toml` is what the
release workflow publishes under, so `mdeploy/stack/runner-binary.ts` reads it
there and turns it into the two addresses a host installs from. A store value
would pin a fleet to whatever was current the day someone seeded it, and drift
from the commit the rest of the deploy is shipping.

```
VERSION=0.9.5                      install a different published release
RUNNER_ARTIFACT_SOURCE=build       opt in to a per-commit build instead
RUNNER_ARTIFACT_REF=<40 hex>       the commit it was staged for
```

The staging bucket is not a variable: the composition root that knows the cloud
composes it — `sst.config.ts` from the account id — so a GCP stage has none and
`build` is refused there rather than resolved into an `s3://` address that would
fail on the host.

Resolved in the stack, and synchronously, which is why the digest is not part of
it: both engines evaluate the stack without awaiting anything, so nothing there
can read a `.sha256`. The host does instead — it fetches the manifest beside the
tarball and refuses to install unless it names exactly that file. The cost is
worth stating: the bytes are not pinned in the engine's state, so a republished
asset under one version is a case no deploy can see. That is the incumbent
path's exposure too, and the reason `immutableTags` exists for images.

## How a new runner binary reaches a live host

Every provider creates a runner with its boot script and image in
`ignoreChanges`, and `protect: true` on top: a host holds `/var/lib/boxlite` and
the libkrun VMs in its memory, so it is never replaced. That means the boot
script runs exactly once and "installed at boot" is "never" for a host that
already exists.

So a deploy lands the binary in place. `UpgradeRunnerBinary*` — one command per
host, chained so the dependency graph sequences them — runs a converge-guarded
payload on each: leave a host already serving the target alone, leave one that is
still bootstrapping alone, otherwise fetch the tarball and its manifest, verify,
swap the binary, restart, and wait for the health route to report the new
identity before the next host is touched. A failure stops the chain with the
unvisited hosts still serving. A host running something *newer* than the target is
refused rather than reverted, so a deliberate hand-install survives an unrelated
deploy.

The same command carries one more thing a host cannot be told after first boot:
`/etc/boxlite/runner.env`. It is written once, by the boot script, and a stage
that moves its domain leaves every existing host calling a name that no longer
resolves — unreachable from the control plane, and so unable to be told. On AWS
the convergence rides the same per-host command as the binary; on GCP it is a
second resource in the one policy assignment, so a host still takes one turn.
Either way a host that already agrees is left alone, which is what keeps a
converged fleet from restarting its boxes on every deploy.

Nothing in a deploy can lift that refusal, and that is deliberate: a stored flag
would be a stage that quietly permits downgrades on every future deploy, which is
the surprise the guard exists to prevent. Rolling backwards is a decision someone
makes at a moment, watching the output:

```
npm run runner:update -- --stage dev --version 0.9.5 --allow-downgrade
npm run runner:update -- --stage dev --host boxlite-runner-2     # one host
npm run runner:update -- --stage prod --confirm                  # protected stages
```

It shares the payload, the transports and the one-host-at-a-time sequencing with
the deploy rather than reimplementing them — `mdeploy/src/runner-update.ts` only
answers the two questions a deploy answers structurally: which hosts, and in what
order. It discovers the fleet from the cloud (`Name=boxlite-runner-*` / the
instance name) rather than from the engine's state, because it has to work on a
fleet whose last deploy failed halfway, and it walks the fleet's own order —
`default`, then `2`, `3`, … — so "which hosts are still serving" means the same
thing after a failure as it did before. Release targets only: a build is
addressed by a commit, and installing one is what deploying that commit does.

## Iterating on the runner itself

An unreleased runner change reaches a stage as a per-commit build rather than a
release. `npm run runner:build -- --stage dev` builds a Linux AMD64 runner from
this checkout, stamps the commit into the health route's version, and stages it
under the commit — then prints the deploy that installs it:

```
RUNNER_ARTIFACT_SOURCE=build RUNNER_ARTIFACT_REF=<ref> npm run mdeploy -- --stage dev
```

The checkout must be clean, submodules included: a commit-keyed object holding
uncommitted work would claim bytes that commit does not produce, and nothing
downstream could tell. Publication is write-once — everything downstream treats
version+commit as an identity and looks at no content, so changed bytes need a
new commit rather than a second upload. Either cloud stages it, into that
stage's own artifacts bucket — S3 on AWS, Cloud Storage on GCP — under the one
key `runner/<commit>/`, which is also the address the deploy resolves and the
only prefix the hosts are let read. `npm run bootstrap -- --stage <stage>`
creates the bucket; a stage without one installs a published release.

The channel differs per cloud and needs one prerequisite each:

| | AWS | GCP |
|---|---|---|
| transport | `ssm send-command`, polled to a terminal status | `gcloud compute ssh --tunnel-through-iap` |
| what admits it | `AmazonSSMManagedInstanceCore` on the runner role | `RunnerIapFirewall`, plus OS Login on the instance |
| deployer needs | the deploy role's existing SSM grants | `roles/iap.tunnelResourceAccessor`, `roles/compute.osAdminLogin` |
| CLI on the deployer | `aws` | `gcloud` |

Neither opens a way in for a person: the GCP rule admits Google's IAP forwarding
range alone, and reaching that tunnel is an IAM question `bootstrap/gcp.ts`
answers for the deployer and nobody else.

## Two clouds, one stage at a time

`mstage.config.json` declares `home` for the repository, and per stage where one
differs:

```json
"stages": {
  "dev":     { "region": "ap-southeast-1" },
  "prod":    { "region": "ap-southeast-1", "protect": true },
  "dev2":    { "home": "gcp", "region": "asia-southeast1", "project": "your-first-project",
             "zone": "asia-southeast1-b" }
}
```

That one field picks the store backend, the identity, the provider bundle the
stack is built from, the engine that applies it, and the registry kind images
are published to. Nothing above those seams branches on a cloud.

The engine differs because of state, not preference. SST keeps state only in S3,
R2 or a directory on the machine, so a GCP stage deployed through SST would need
an AWS bucket — and therefore an AWS credential — to deploy into Google.
Pulumi's own backend takes `gs://`, so a GCP stage keeps its state in the
project it deploys into and needs no second cloud in the deploy path at all.

## Where the clouds genuinely differ

Written down rather than smoothed over:

| Module | AWS | GCP |
|---|---|---|
| network | VPC, EC2 NAT, security groups | VPC, Cloud NAT, firewall rules keyed on service accounts, Private Service Access |
| database | RDS, password copied into Secrets Manager | Cloud SQL private IP, password generated into Secret Manager |
| cache | ElastiCache | Memorystore |
| storage | S3, grant scoped by ARN prefix | Cloud Storage, project role bounded by a CEL condition |
| cluster | one ECS cluster | nothing — Cloud Run has no cluster |
| clickhouse | EC2 + retained EBS, schema reconciled over SSM | GCE + retained disk, schema applied at boot |
| mail | SES, DKIM and DMARC verified | nothing — Google has no sending service; a relay is named or mail is off |
| api | ECS behind an ALB and a CDN | Cloud Run behind a global load balancer |
| edge | ECS behind an NLB with `443/tls` | **a managed instance group** behind a global proxy load balancer, wildcard via Certificate Manager |
| runners | EC2, `cpuOptions.nestedVirtualization` | GCE, an N4 family, Hyperdisk and `enableNestedVirtualization` |
| alarms | CloudWatch on emitted counters | alert policies on log-based metrics |

Two of those are worth reading the file for.

**The proxy is not a Cloud Run service.** Cloud Run cannot be a backend of the
load balancer it needs, so the GCP proxy runs on container-optimised VMs, which
costs a machine per zone the AWS side does not spend.

The balancer *terminates*, on both clouds. This document and three file headers
used to say the opposite — that the proxy reads the SNI name itself and needs a
layer-4 path. It does not: it routes on the Host header (`parseHost` in
`apps/proxy/pkg/proxy/get_box_target.go`), and the AWS side's `443/tls` NLB
listener terminates too, handing the task plaintext. Built as a real passthrough,
the GCP edge served no certificate at all — `apps/proxy` has no ACME client and
reads two files nothing placed — so every box hostname failed its handshake.
`stack/providers/gcp/edge.ts` says all of this at the top.

**A runner needs three things on GCP that it needs none of on AWS**: a machine
family that can nest (E2 cannot, and nor do the AMD families but N4D),
`enableNestedVirtualization` set explicitly, and a Hyperdisk boot disk — N4
attaches no Persistent Disk at all, so the `pd-balanced` an N2 fleet used is a
create-time refusal rather than a slower disk. Plus the guest's `/dev/kvm` made
readable by the account the runner runs as. Those are what
`scripts/deploy/gcp/create-instance.sh` and `setup-kvm.sh` have been doing by
hand for a developer's own box host; `stack/providers/gcp/runners.ts` and
`stack/runner-boot.ts` make them part of a deploy. No `minCpuPlatform`: N4 has
one CPU platform, and naming an older one is rejected rather than read as a
floor already met.

**Only the GCP balancer strips the container's `/api` prefix.** The API mounts
every route under `/api` so one image can serve the dashboard beside it. On GCP
the load balancer puts that prefix back for the control plane's own hostname, so
`https://api.<STACK_DOMAIN>/boxes` and `https://api.<STACK_DOMAIN>/api/boxes`
reach the same route and an SDK profile needs only the host. An ALB forwards the
path unchanged and has no rewrite to give, so on AWS the prefix is still the
client's to supply — which is why the longer form keeps being served on both.

**A DNS authorization cannot be renamed in place.** Certificate Manager admits
one per `(project, domain, type)`, so a replacement under a new name is refused
as a duplicate tuple before any name is compared — and the delete that would
free it is refused in turn by the certificate issued against it and by the
regional proxy above that. A stage whose internal chain predates the current
naming converges only by deleting that chain — forwarding rule, target proxy,
certificate, authorization — and letting the next apply rebuild it, with the
in-VPC control plane unreachable in between. A stage that creates the chain
under the current naming never meets this, and an apply no longer discovers it
the expensive way: `mdeploy` asks the project what it already holds and refuses
before the engine is handed anything.

Both chains are asked, from opposite directions. The control plane's
authorization carries its host in its name, so what matters is whether the
resource proving `api.<STACK_DOMAIN>` is the one this apply creates. The proxy's
carries the stage's name and nothing else, so what is asked of it is whether the
domain it proves is still `PROXY_DOMAIN`.

They differ because adopting the keyed name is itself the replacement the key
exists to make possible: free while no stage holds the old name, and a wedge for
every stage that does. The control plane's was moved on those terms; the proxy's
stays fixed because every stage has one. The move is still available later, one
stage at a time, whenever that stage's chain is rebuilt for another reason.

**Splitting the public certificate is paid once.** The control plane and the
dashboard each get their own managed certificate now, so a stage that still
holds the single certificate covering both re-issues both on the first apply
after the split, and the balancer presents neither until each is `ACTIVE`. What
that gap buys is that no later move of one name can darken the other.

**A zone is declared, not derived.** `mstage.config.json` takes an optional
`zone` beside the region, and the two machines in the stack — the runners and a
self-hosted ClickHouse — are created in it. The default is the region's first,
and the reason it is overridable is that a machine family is stocked per zone:
`asia-southeast1-a` answers `stockout` for an N4 while `-b` creates one, and a
derived-only zone makes that a deploy nothing can fix without editing code.

## One dispatch

`mdeploy-all.yml` is the whole of it from a browser: pick a stage, pick what the
commit needs — `api+runner`, `api` or `runner` — name a commit or a tag, and say
whether to apply or only preview. What it does first is read: does this stage
already hold the images for that commit, and a runner binary staged under it?
Each answer decides one leg.

```
ref ──▸ source? ──▸ plan ──┬─▸ promote-api / build-api ───┐
                           └─▸ promote-runner / build-runner ─┴─▸ deploy
```

`auto_promote_from` is where it looks when the stage holds neither — `dev` by
default, `none` to switch it off. A promotion is preferred over a build for a
reason that is not speed: it moves the bytes that stage already serves, and a
rebuild of one commit is not byte-identical, while everything downstream treats
version+commit as an identity and never looks inside. Two stages that each built
the same commit hold two sets of bytes under one reported version.

Each leg is also dispatchable on its own — `mbuild.yml` for the images,
`mrunner.yml` for the runner binary, `mdeploy.yml` for the apply — and the
orchestrator calls exactly those.

**A promotion crosses two stages, and on GCP that means two projects.** One
identity does the whole move: the destination's, because that is the one that
has to write. So the destination's deployer needs read access on the source's
project, granted there and not here:

```
gcloud projects add-iam-policy-binding <source project> \
  --member=serviceAccount:<destination deployer> --role=roles/artifactregistry.reader
gcloud storage buckets add-iam-policy-binding gs://<source artifacts bucket> \
  --member=serviceAccount:<destination deployer> --role=roles/storage.objectViewer
```

The registry grant is what `mbuild promote` pulls with; the bucket grant is what
`runner:promote` copies from, and it is scoped to the one bucket rather than the
project. Without them a promotion fails at the pull with a permissions error and
nothing is written — `bootstrap` does not make this grant, because it runs
against one project and this one belongs to the other.

## Commands

```
npm run mstage login                                   who am I, on this stage's cloud
npm run mstage env list     -- --stage dev             names only
npm run mstage env list     -- --stage dev --values    values, asked for explicitly
npm run mstage env digest   -- --stage dev             expect: / got:
npm run mstage env set      -- --stage dev --digest KEY=VALUE
npm run mstage state unlock -- --stage dev             what a killed deploy left
npm run mstage config put   -- --stage dev             this stage's block, into its GitHub environment
npm run mstage config get   -- --stage dev             it back, from the variable or the file
npm run mstage state edit   -- --stage dev             the checkpoint, in $EDITOR

npm run mbuild publish -- --tag <sha> --stage dev      build and push every artifact
npm run mbuild promote -- --tag <sha> --from dev --to prod
npm run mbuild verify  -- --tag <sha> --stage dev      does this stage hold this commit

npm run runner:build   -- --stage dev                  build this commit's runner and stage it
npm run runner:build   -- --stage dev --check          is it staged already, without building
npm run runner:promote -- --tag <sha> --from dev --to prod

npm run mdeploy -- --stage dev --diff                  read this before the first apply
npm run mdeploy -- --stage dev
npm run mdeploy -- --stage dev --remove --confirm
```

## What is verified, and what is not

| | |
|---|---|
| mstage — sign-ins, the store, digests, object versions, state repair | 361 tests |
| mbuild — addresses, the publish sequence, the scan gate, the workflow | 64 tests |
| mdeploy — both configs, the environment, the wiring, both bundles | 211 tests |
| the incumbent stack and its release guards, plus `bootstrap/gcp.ts` | 533 tests |
| mstage, mbuild **and mdeploy** typecheck | `tsc` clean, without `sst install` |
| every GCP provider, applied | `dev2`, in `asia-southeast1` |

`mdeploy` being inside the typecheck is the one place this diverges from the
repository the pattern came from, where it was left outside. `globals.d.ts`
declares what both engines inject, so a contract that a provider stopped
satisfying is a compile error rather than a runtime one. What it does not check
is a resource argument's spelling — that needs the providers' own types, and the
file says so.

## What is left

- **A person's own grants.** `bootstrap/gcp.ts` creates everything an identity
  needs beyond the project — the enabled APIs, the state bucket, the workload
  identity pool, the deployer and publisher service accounts, the Artifact
  Registry repository — and wires `GCP_WORKLOAD_IDENTITY_PROVIDER`,
  `GCP_DEPLOYER` and `GCP_IMAGE_PUBLISHER` into GitHub the same way the AWS
  half wires its own role ARN. `DEPLOYER_ROLES` is what CI federates into; a
  *local* deploy runs as the person's application default credentials and holds
  none of it, so the first local apply fails on whichever role that person
  lacks — `roles/servicenetworking.networksAdmin`, for the Private Service
  Access peering, is the one it reaches first. Impersonating the deployer
  instead of granting the person is the shape this should take. Still manual
  either way: the project and its billing account, which no bootstrap can
  create.
- **Building the images on a workstation.** `mbuild publish` builds locally, and
  on Apple Silicon the api image cannot be built at all: colima's VM is aarch64
  with no buildx, and under QEMU `cpu-features`' gyp build segfaults compiling
  its own sources. `DOCKER_DEFAULT_PLATFORM=linux/amd64` is enough for a
  tsc-only image and not for this one. Until mbuild can hand the build to
  something amd64, a workstation publishes through Cloud Build into the same
  repository, at the addresses `addressesFor` resolves.
- **Retiring the incumbent.** `deploy-infra.yml`, `deploy-release.yml` and
  `build-apps-api-image.yml` still run. Two publishers writing immutable tags
  into one repository is a race that reads as a broken build, so retiring them
  is the step after the first green `mdeploy` dispatch.
- **The application on GCP.** Deploying the stack is not the same as running on
  it: the API's object-storage client reaches for STS, and the runner's volume
  mount is Mountpoint for S3. The deploy is portable ahead of the thing it
  deploys.
