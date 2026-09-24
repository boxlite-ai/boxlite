## TL;DR

mdeploy selects the stage's cloud engine, validates its inputs, and applies one shared BoxLite resource model.

# mdeploy reference

[Infrastructure index](../README.md) · [Deployment walkthrough](deployment.md) · [Architecture](architecture.md)

## Execution path

```text
mstage: stage declaration + identity + encrypted environment
  → mdeploy: intent and protection checks
    → GCP: Pulumi → GCP providers → GCS state
    → AWS: SST → AWS providers → SST state
```

The current command is `npm run mdeploy -- --stage <stage>` from `apps/infra`.
The retained `npm run deploy` command uses `deployment/sst.ts` and the legacy `stack/` tree;
its flags, state assumptions and post-deploy checks are not interchangeable with mdeploy's.
Preview any transition against the intended stage before applying it.

## Inputs

| Input | Owner |
| --- | --- |
| App identity, build artifacts, environment groups | Committed `mstage.env.json` |
| Cloud, region/project, registry and resource sizing | Ignored `.mstage.config.json` |
| Domains, fleet count, secrets and feature settings | Encrypted stage environment |
| Container identity | Invocation's `BOXLITE_IMAGE_TAG` |
| Runner release | Workspace `Cargo.toml`, or invocation's `VERSION` |
| Runner commit build | `RUNNER_ARTIFACT_SOURCE=build` and `RUNNER_ARTIFACT_REF=<full-sha>` |

See [configuration](configuration.md) for writing and verifying each input.
`BOXLITE_IMAGE_TAG` accepts a full lowercase SHA or `vX.Y.Z-<sha>` for release images.
The environment describes the desired deployment; setting a tag does not build an artifact.
Use [mbuild](../mbuild/README.md) and the [runner runbook](mdeploy.md) to prepare it first.

## Runner convergence

Runner hosts retain local box state and are protected against replacement. Boot-image/startup
changes are ignored for existing hosts; binary and unit-environment updates have a separate path.

| Home | Update mechanism | Completion boundary |
| --- | --- | --- |
| GCP | One OS Config policy assignment, with a one-host disruption budget | Pulumi completion means the assignment exists; agents converge asynchronously |
| AWS | Per-host SSM commands chained by the resource graph | Commands poll for completion before the next host |

Updates verify the artifact checksum and readiness. Already-converged hosts need no restart;
release downgrade requires the explicit operator command. GCP's `runner:update` changes the
fleet policy, and the next deployment reasserts the checkout's target. It does not support `--host`.
See [runner verification and recovery](mdeploy.md) before calling a rollout complete.

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
| network | VPC, EC2 NAT, security groups | VPC, Cloud NAT, firewall rules keyed on service accounts (on the Cloud Run egress subnet's IP range where a Cloud Run service reaches a VM), Private Service Access |
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

`mdeploy-all.yml` is the whole of it from a browser, and the only way a stage is
rolled out: pick a stage, pick what the ref needs — `api+runner`, `api` or
`runner` — name a commit, a pull request or a release tag, and say whether to
apply or only preview. What the ref is decides the rest.

```
a commit SHA, or #<number> for a pull request        (dev only)
  resolve ─▸ plan ─┬▸ mbuild        publish <sha> images
     │             ├▸ build-runner  compile, stage in this stage's bucket
     │             └▸ deploy        RUNNER_ARTIFACT_SOURCE=build
     └▸ a pull request resolves to the commit it would merge to,
        and must be open and known to merge cleanly

a release tag v<X.Y.Z>
  resolve ─▸ plan ─┬▸ mbuild-release  publish (dev) / promote (prod)
     │             └▸ deploy          RUNNER_ARTIFACT_SOURCE=release
     └▸ the GitHub Release must exist and already carry
        boxlite-runner-v<X.Y.Z>-linux-amd64.tar.gz + .sha256
```

**A pull request deploys its merge, not its head.** `refs/pull/N/merge` is the
request's own base plus the request, which is the tree that would land; a head
is the same work missing whatever its base gained since it was branched, so
shaking one out answers about a tree nobody will merge. It buys no ordering
against the ref this workflow's definition came from — on the dev path that ref
need not be the request's base, and the merge can sit behind it. The request has
to be open and known to merge cleanly. GitHub computes mergeability lazily, so
`resolve` polls rather than failing a dispatch on a cold cache; it reads the
state off the last poll rather than the first, because a request can be closed
while this waits; and it requires MERGEABLE rather than merely not
CONFLICTING, because an unknown answer can arrive beside a merge commit
computed before the last push.

A fork's request is accepted and logged as one. Two things stand behind that.
Dispatching at all needs write access on this repository. And `build-runner`
and mbuild's publish, which are the jobs that compile the request's tree, bind
the stage's Environment, where `bootstrap` asks for at least one required
reviewer on every stage it creates (`bootstrap.ts:1237`, and `:1084` on GCP) —
so a fork's tree waits on a human pressing approve.

What that approval is worth is narrower than it looks, in three ways worth
knowing before leaning on it. It is a person unblocking a run, not a reading
of the diff. The reviewer `bootstrap` requests defaults to whoever ran it, so
on a stage nobody has since edited, the dispatcher may be the approver.
And `ensureGithubEnvironment` falls back to an Environment with no reviewers
at all when GitHub refuses protection rules outright (`bootstrap.ts:595`),
which needs a private repository without Pro/Team/Enterprise — not this one,
but a fork of this setup into one loses the gate on every stage except prod,
which fails closed instead.

`dev` here currently also carries `prevent_self_review`, alongside
`can_admins_bypass: true` — so it excludes a dispatcher who is not an admin.
Nothing in this repository sets either: `githubEnvironmentPayload`
(`bootstrap/github.ts:31`) sends `reviewers` and `deployment_branch_policy`
and no more. Both were applied by hand, and since the environment call is a
`PUT`, a `bootstrap` rerun is the thing most likely to lose them — worth
re-checking after one rather than assuming. Read them as the state of this
repository today, not as part of the shape bootstrap reproduces.

**prod takes a release tag and nothing else.** A commit or a pull request aimed
at it is refused in `resolve`, before any Environment is bound. Promotion is
preferred over a build for a reason that is not speed: it moves the bytes dev
already serves, and a rebuild of one commit is not byte-identical, while
everything downstream treats version+commit as an identity and never looks
inside. Two stages that each built the same commit hold two sets of bytes under
one reported version.

**A release installs the runner it was cut from, not a rebuild of it.**
`mdeploy/stack/runner-binary.ts` addresses the tarball on the GitHub Release
directly, so the release path compiles no runner at all — and `resolve` refuses a
tag whose Release is missing, still a draft, or carrying no runner asset yet,
because that download otherwise 404s on the host at boot, long after the apply
reported success.

**A release is refused at a commit whose mbuild answers differently.** Two
answers a release reads arrived after the first tags were cut. `--artifact` and
`--version`: an mbuild without them drops them as unknown flags, so a tag cut
before them publishes commit images at `<sha>`, reports success, and leaves
`v<X.Y.Z>-<sha>` unwritten for the promotion to look for. And exit 66 for
absence: an mbuild that reports a plainly missing artifact as a plain failure
stops every gate on "could not tell whether dev holds it", against a registry
that answered. `mbuild-release.yml`'s own `resolve` — not the one above — reads
`apps/infra/mbuild/package.json` out of the released commit and refuses
anything below the minimum that step names. That is what mbuild's package
version is for: it says which contract a commit carries, where merge topology
and the presence of a file only guess. Raise it, and the minimum with it,
whenever a release starts reading an answer an older mbuild does not give.

The images half is also dispatchable on its own: `mbuild-release.yml` publishes
or promotes a version. `mbuild.yml` is callee-only — nobody publishes a bare
commit by hand.

**A promotion crosses two stages, and on GCP that means two projects.** One
identity does each move — the destination's, because that is the one that has to
write — but the two legs do not run as the same account: `mbuild.yml` and
`mbuild-release.yml` authenticate as the destination's `GCP_IMAGE_PUBLISHER`,
and `mdeploy-all`'s own jobs as its `GCP_DEPLOYER`. Each of those two needs read
on the source, in a policy the source's project owns.

The destination declares where it is promoted from, and `bootstrap` makes both
grants:

```json
"prod": { "home": "gcp", "project": "boxlite-prod-project", "promoteFrom": "dev" }
```

```
npm run bootstrap -- --stage prod --confirm
```

It is the destination's bootstrap that makes them because that is the run which
knows both account names — it just created them — and the source has to be
bootstrapped first, since the bucket and the repository being granted on are
its own. An operator whose credentials do not administer the source is the
ordinary case rather than an error: the two commands are printed instead, for
whoever does hold that project.

```
gcloud projects add-iam-policy-binding <source project> \
  --member=serviceAccount:<destination publisher> --role=roles/artifactregistry.reader \
  --condition=None
gcloud storage buckets add-iam-policy-binding gs://<source artifacts bucket> \
  --member=serviceAccount:<destination deployer> --role=roles/storage.objectViewer \
  --condition=None
```

The registry grant is what `mbuild promote` pulls with, and it goes to the
publisher rather than the deployer because that is the account the job federates
— each stage has its own, so the destination's must be named. The bucket grant is
what `runner:promote` copies from, scoped to the one bucket rather than the
project. It is object reads only: `storage.buckets.get` is in no object role,
which is why `runner:promote` reads the source by listing it and never asks that
bucket for its metadata. Without the grants a promotion fails at the read with a
permissions error and nothing is written.

`--condition=None` is not decoration. `add-iam-policy-binding` reads the policy,
edits it and writes it back, and it refuses to edit in a binding carrying no
condition when the policy it just read holds one — unless the command says that
is what it means. Neither command above can know which case it is in before it
runs, and a refusal leaves the policy untouched. The bucket grant meets such a
policy whenever the source stage stages its runner binary rather than installing
a release: the deploy attaches `runner-artifacts-only` to that bucket. Against
one, a line without the flag is refused outright where no prompt can be
answered, and prompts where one can.

`promoteFrom` is read by nothing at deploy time. It exists for `bootstrap`,
which has to know whose project holds the bucket and repository it is granting
on; a rollout no longer chooses a source at all, because a promotion's source is
dev.

### Known loose ends

Two, both noticed while the pull-request shape landed and both deliberately
left for their own change rather than folded into it:

- `.github/actions/resolve-ref` still declares a `fallback` input and a
  `resolved-from` output that no caller uses. The action does read its own
  `fallback` (`action.yml:53`); what is gone is anyone passing one.
  `mbuild.yml` was the last consumer of either, and the two remaining call
  sites pass and read neither. Removing them edits an action two workflows
  call, so it wants its own verification.
- `mdeploy-all`'s `line` label and the two step summaries built from it have no
  test. `mbuild-release-workflow.test.ts` pins a `run-name` and is the pattern
  to follow.

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
| every GCP provider, applied | `dev` and `prod`, in `us-east5` |

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
