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

One shared write remains: deployment assets are content-addressed in a single `sst-asset-*` bucket
with no stage in the key, so every stage writes there. A write is idempotent — the key *is* the
content hash — but a delete is not, so a stage can remove an object another stage's next update
expects. It stays because `sst remove` needs it, and the blast radius is a redeploy: assets are
rebuilt from the checkout, not recovered from the bucket.

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
