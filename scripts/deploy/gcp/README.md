# GCP deployment scripts

Imperative `gcloud` helpers for the pieces of BoxLite that run on Google Cloud.
The control plane's IaC lives in [`apps/infra`](../../../apps/infra) and targets
AWS; these scripts cover what that stack does not.

| Script | Purpose |
| --- | --- |
| `create-instance.sh` | GCE VM with nested virtualization for running BoxLite itself |
| `check-nested-virt.sh` | Verify nested KVM on such a VM |
| `enable-nested-virt.sh` | Enable nested KVM on an existing VM |
| `setup-kvm.sh` | KVM permissions on the VM |
| `create-memorystore-redis.sh` | Memorystore for Redis for the BoxLite API, plus Secret Manager wiring |
| `create-network.sh` | A `boxlite-<stage>` VPC with subnet, Cloud NAT, ClickHouse firewall rules and Private Service Access |
| `create-clickhouse-host.sh` | Self-hosted ClickHouse on a GCE VM with a persistent data disk, mirroring the AWS `self-hosted` mode |
| `clickhouse-startup.sh` | The VM's startup script; not run by hand |

The three database scripts (`create-network.sh`, `create-clickhouse-host.sh`,
`create-memorystore-redis.sh`) take `--stage` and derive `boxlite-<stage>-*`
names from it, are idempotent, support `--dry-run`, and never print a
password. The operator needs `roles/editor`; `create-network.sh` additionally needs
`roles/servicenetworking.networksAdmin` for the Private Service Access peering,
and `create-clickhouse-host.sh` needs `roles/secretmanager.admin` on the
`boxlite-<stage>-*` secrets to grant the VM's service account read access
(both were granted to the operator as IAM-conditioned project bindings).

## The dev-db stage

`dev-db` is a dedicated VPC for validating these scripts. Bring it up in order:

```bash
./scripts/deploy/gcp/create-network.sh --stage dev-db
./scripts/deploy/gcp/create-clickhouse-host.sh --stage dev-db --smoke
./scripts/deploy/gcp/create-memorystore-redis.sh --stage dev-db \
  --network boxlite-dev-db --reserved-ip-range boxlite-dev-db-private-services
```

`create-network.sh` creates VPC `boxlite-dev-db` (subnet 10.40.0.0/20 with
Private Google Access, Cloud NAT for image pulls), two ingress rules (tcp:8123
from the subnet and tcp:22 from the IAP range, both to tag `boxlite-clickhouse`),
and the Private Service Access range `boxlite-dev-db-private-services`
(10.90.0.0/16) that Memorystore attaches to. Without the peering permission it
still creates everything else and prints the one `vpc-peerings connect` command
for someone who has it.

## ClickHouse

`create-clickhouse-host.sh` is the GCE port of the AWS self-hosted mode in
`apps/infra/stack/clickhouse.ts`, `apps/infra/scripts/clickhouse-host.ts` and
`apps/infra/scripts/clickhouse-ops.mjs`: one `e2-standard-2` Ubuntu 24.04 VM, a
50 GB `pd-balanced` data disk that is attached with `auto-delete=no` and never
deleted by the script, the digest-pinned `clickhouse/clickhouse-server` image in
Docker on host networking, plaintext HTTP on 8123 inside the VPC only, and the
same three users: `boxlite_admin`, `otel_writer`, `otel_reader`. Their passwords
live in Secret Manager as `boxlite-<stage>-clickhouse-{admin,writer,reader}`;
the VM's own service account `boxlite-<stage>-clickhouse@` reads them at boot,
and only their sha256 reaches ClickHouse.

The schema is `apps/infra/clickhouse/otel-schema-v0.144.0.sql`, rendered with
the 72-hour TTL and passed to the VM as the `clickhouse-schema` metadata
attribute, so both clouds run one schema file.

There is no SSH. `clickhouse-startup.sh` runs on every boot, formats and mounts
the data disk once, installs Docker once, rewrites its files only when they
change, starts the service, applies the schema, grants `otel_writer` and
`otel_reader`, sets the TTL on all seven tables, asserts the result (table
count, grants, one probe row per table as `otel_writer`, one read as
`otel_reader`), and reports through the guest attribute `boxlite/clickhouse`:

```text
starting:<boot-id>          the script is running
failed:<step>               e.g. failed:secret-access when the service account cannot read a secret
ready:<digest>:7:<boot-id>  done; the operator script waits for this
```

Guest attributes survive a reset, so the boot id is what tells a fresh `ready`
from the previous boot's; the operator script compares against the value it saw
before rebooting.

```bash
gcloud compute instances get-guest-attributes boxlite-dev-db-clickhouse --zone asia-southeast1-b --query-path=boxlite/clickhouse
gcloud compute instances get-serial-port-output boxlite-dev-db-clickhouse --zone asia-southeast1-b | tail -n 80
```

Routine operations:

- `--reboot-vm` refreshes the startup script, schema, image reference and
  retention on the instance metadata and resets the VM. Use it after editing
  `clickhouse-startup.sh`, bumping the image digest, or rotating a password
  (add a secret version first). This is the GCE equivalent of the AWS
  `userDataReplaceOnChange`.
- `--recreate-vm` deletes and recreates the VM for immutable changes (machine
  type, service account, subnet). The data disk stays and is reattached.
- `--smoke` runs a one-off Cloud Run job on the same subnet, as the VM's
  service account, that inserts a marker row as `otel_writer`, reads it back as
  `otel_reader`, and checks that `otel_reader` cannot insert and that a wrong
  password is refused. Passwords reach the job through `--set-secrets`.

Wiring, once a collector and API run in this VPC:

```text
otel-collector: CLICKHOUSE_ENDPOINT=http://<vm ip>:8123  CLICKHOUSE_USERNAME=otel_writer  CLICKHOUSE_PASSWORD=<boxlite-<stage>-clickhouse-writer>
API:            CLICKHOUSE_URL=http://<vm ip>:8123       CLICKHOUSE_USERNAME=otel_reader  CLICKHOUSE_PASSWORD=<boxlite-<stage>-clickhouse-reader>
```

Limits: a single VM with no replica; a disk failure loses at most 72 hours of
telemetry, which is what the AWS host accepts too. Port 9000 is bound on the
host and only the firewall keeps it closed. The image is pinned by digest, so a
security update is a deliberate digest bump plus `--reboot-vm`.

## Redis for the API

`create-memorystore-redis.sh` provisions the Redis the API expects, matching the
AWS ElastiCache settings in `apps/infra/stack/foundation.ts`: one node, cluster
mode off, TLS required, AUTH required, private network only, no persistence.
Memorystore for Redis (standalone) is the only GCP product that fits: the API
uses logical DB 1, `EVAL`, `BRPOP`, multi-key pipelines and plain pub/sub (the
Socket.IO Redis adapter adds pattern subscriptions on top), which do not all
work on Memorystore for Valkey or Redis Cluster.

Defaults match the `dev` stage in project `avid-vine-500315-u4`: instance
`boxlite-dev-cache`, Basic tier, 1 GiB, Redis 7.2, region `asia-southeast1`,
attached to VPC `boxlite-backoffice-dev` through its existing Private Service
Access range. `--stage` renames the instance, secrets, labels and display name
to `boxlite-<stage>-*`; the network and reserved range stay explicit flags
because the `dev` network does not follow that pattern. The project itself
comes from the active gcloud configuration unless `--project` is given. Every
value is a flag; `--help` lists them.

### Run

```bash
gcloud auth login
gcloud config set project avid-vine-500315-u4

./scripts/deploy/gcp/create-memorystore-redis.sh --dry-run   # print the commands
./scripts/deploy/gcp/create-memorystore-redis.sh             # create (5-10 min)
```

The operator needs `roles/editor` (or the equivalent Memorystore, Secret Manager
and Service Usage permissions). The script is idempotent: an existing instance
is left alone and only a settings drift warning is printed, and a secret version
is added only when the stored value differs.

What it creates:

- Memorystore instance `boxlite-dev-cache`, reachable only from the VPC on a
  `10.120.0.0/16` address. **With TLS the port is 6378, not 6379.**
- Secret `boxlite-dev-redis-auth`: the AUTH string. The script never prints it.
- Secret `boxlite-dev-redis-ca`: the instance's server CA bundle (PEM). Google
  signs the TLS certificate with a private CA, so clients must trust this.

### Wire the API

The API reads `REDIS_HOST`, `REDIS_PORT`, `REDIS_PASSWORD` and `REDIS_TLS`
(`apps/api/src/config/configuration.ts`). On Cloud Run:

```bash
--set-env-vars=REDIS_HOST=<host>,REDIS_PORT=6378,REDIS_TLS=true \
--set-secrets=REDIS_PASSWORD=boxlite-dev-redis-auth:latest,REDIS_TLS_CA=boxlite-dev-redis-ca:latest
```

Two follow-ups are outside this script:

- `REDIS_TLS=true` currently gives ioredis an empty `tls: {}`, which rejects the
  Google private CA. The API needs a `REDIS_TLS_CA` option before it can connect
  to a TLS Memorystore instance. Only the CA is needed: the server certificate
  carries the instance IP as a SAN, so Node's default hostname check passes.
- Granting the API's service account `roles/secretmanager.secretAccessor` on the
  two secrets requires `setIamPolicy`, which `roles/editor` lacks. A project
  owner runs the `add-iam-policy-binding` commands the script prints.

### Verify from inside the VPC

Nothing outside the VPC can reach the instance. A throwaway Cloud Run job on the
same subnet exercises the exact path the API will use:

```bash
REDIS_HOST=$(gcloud redis instances describe boxlite-dev-cache --region=asia-southeast1 --format='value(host)')
gcloud run jobs create boxlite-dev-redis-smoke --region=asia-southeast1 \
  --image=docker.io/library/redis:7.2-alpine \
  --network=boxlite-backoffice-dev --subnet=boxlite-backoffice-dev --vpc-egress=private-ranges-only \
  --service-account=<sa-with-secretAccessor> \
  --set-env-vars=REDIS_HOST=$REDIS_HOST,REDIS_PORT=6378 \
  --set-secrets=REDISCLI_AUTH=boxlite-dev-redis-auth:latest,/etc/redis-ca/ca.pem=boxlite-dev-redis-ca:latest \
  --max-retries=0 --task-timeout=120s \
  --command=sh --args=-c,'R="redis-cli --tls --cacert /etc/redis-ca/ca.pem -h $REDIS_HOST -p $REDIS_PORT"; $R PING && $R -n 1 SET smoke 1 EX 30 && $R EVAL "return 1" 0'
gcloud run jobs execute boxlite-dev-redis-smoke --region=asia-southeast1 --wait
gcloud run jobs delete boxlite-dev-redis-smoke --region=asia-southeast1 --quiet
```

`REDISCLI_AUTH` keeps the password out of argv and logs.

### Rotate the AUTH string

```bash
./scripts/deploy/gcp/create-memorystore-redis.sh --rotate-auth
```

Memorystore has no regenerate verb, so rotation disables and re-enables AUTH.
The instance accepts unauthenticated connections for a few seconds and drops
every client. Fine for `dev`; do not run it against a stage that serves users.

### Limits

- Basic tier has no replica and no persistence. Maintenance and resizes clear
  the data. The API treats Redis as a cache, lock store and wake-up hint with
  Postgres as the source of truth, so this matches the AWS deployment.
- Tier, network, connect mode, reserved range and transit encryption cannot be
  changed after creation. The script warns on drift instead of recreating.
- Google can add a second server CA before retiring the first. Rerunning the
  script stores the new bundle as a secret version; the API must be redeployed
  to pick it up.
