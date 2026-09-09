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
Access range. The project itself comes from the active gcloud configuration
unless `--project` is given. Every value is a flag; `--help` lists them.

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
