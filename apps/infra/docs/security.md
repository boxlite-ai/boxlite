# Infrastructure security

Stage configuration and application secrets are loaded into the environment just before SST starts,
from the stage's SST secret store; the Cloudflare provider credentials come from SSM or the job's
Environment secrets, since reading that store initializes the Cloudflare provider. No workflow writes
configuration to disk, and only keys named by the store's own `BOXLITE_STAGE_CONFIG` manifest are
applied, so a secret written under any other name cannot reach a deploy's environment.

A stage's deploy role reaches its own stage's state and secrets, and no other stage's. One bucket and
one parameter tree hold every stage's, so the role's `s3:*`/`ssm:*` grant on `*` used to let a job
bound to the dev Environment run `sst secret list --stage prod`. Those two are now scoped to this
stage's state prefixes, its passphrase, and the buckets the stack owns.

Three things in that store are shared by construction, and none of them is a stage's secrets:

- `ListBucket` stays at bucket scope, because SST enumerates before it reads. Other stages' key
  *names* remain visible; their contents do not.
- `_fallback` secrets belong to the app rather than a stage, so they cannot be stage-scoped and are
  read-only — a deploy consumes a fallback, setting one is a deliberate operator action.
- `/sst/bootstrap` names the buckets every stage shares and is read before SST knows which stage it
  is running, so it is read-only for the same reason.

Three shared writes remain, and none is narrowed by this change:

- Deployment assets share a single `sst-asset-*` bucket with no stage in the key, so every stage has
  `PutObject`, `DeleteObject` and `DeleteObjectVersion` over all of it. SST derives each key from the
  content hash, which makes an ordinary deploy's writes idempotent — but that is SST's behaviour, not
  a constraint the policy imposes: the grant permits writing arbitrary bytes to any key in the bucket,
  or deleting one another stage's next update expects. It stays because `sst remove` needs the delete,
  and the blast radius is bounded by assets being rebuilt from the checkout rather than recovered.
- `boxlite-volume-*` buckets carry no stage in their names, so `s3:*` over that prefix reaches every
  stage's volumes. Scoping it means renaming the buckets to carry the stage, across the runtime
  boundary, the stack, and buckets that already exist.
- `ssm:SendCommand` on `instance/*` is the widest grant the deploy role holds: an instance ARN
  carries no stage, so a job bound to one stage can run a shell command on any instance in the
  account. Narrowing it needs a Condition on an instance tag the Runner launch template sets, which
  can only be verified against real instances.

The first two predate this change and the third is how Runner upgrades have always been delivered;
they are listed because the paragraph above would otherwise read as a stronger guarantee than the
policy gives.

Two grants reach other stages and are **not** narrowed here, tracked in
[#1255](https://github.com/boxlite-ai/boxlite/issues/1255):

- `ManageBoxLiteRoles` covers `role/boxlite-*`, so a job bound to one stage can rewrite or delete
  another stage's SST-created runtime roles. This stage's own deploy role, every other stage's, and
  the runtime boundary policies are excluded by the `DenySelfPrivilegeEscalation` statement; the
  remaining runtime roles are not.
- `secretsmanager:*` is granted on `*`, so one stage can read and mutate another's secrets.

Both would be scoped by `${GitHubEnvironment}` the way the runtime boundary already scopes
`secretsmanager:GetSecretValue`, but only once a preview run confirms every resource SST creates
carries the stage in its name — a wrong pattern fails a deploy with AccessDenied and needs the
bootstrap stack redeployed to clear. So this section says what the policy grants today rather than
what it should grant.

That policy has not run a real deploy yet. Four of its grant groups were derived from live listings,
and two — Pulumi's provider describe/list calls and the `ssm:SendCommand` document targets — are
reasoned. A gap surfaces as AccessDenied on a preview, and clearing it means redeploying the bootstrap
stack with a wider policy, so preview with `apply=false` before any apply.

Every SST-created IAM role receives the stage runtime permissions boundary through the global role
transform. The checked-in bootstrap CloudFormation template creates the deployment boundary and
the GitHub OIDC trust used before SST can deploy anything.

Runner instances are protected resources. The mandatory policy pack validates their identities,
lifecycle options, and normalized state baseline during real previews and deploys. Runner AMI and
user-data changes are intentionally ignored; binary updates use the serial SSM workflow instead of
replacing stateful hosts.

Pulumi event logs may contain provider inputs. The deployment facade removes stale logs before SST
and newly created logs immediately after SST, including failure and signal paths.
