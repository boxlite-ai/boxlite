# Infrastructure security

Provider bootstrap credentials are loaded just before SST starts. Application secrets stay in the
SST secret store; Cloudflare provider credentials are SecureString values in stage-scoped AWS SSM
parameters. Materialized `.env` files are temporary workflow inputs and are removed unconditionally.

Every SST-created IAM role receives the stage runtime permissions boundary through the global role
transform. The checked-in bootstrap CloudFormation template creates the deployment boundary and
the GitHub OIDC trust used before SST can deploy anything.

Runner instances are protected resources. The mandatory policy pack validates their identities,
lifecycle options, and normalized state baseline during real previews and deploys. Runner AMI and
user-data changes are intentionally ignored; binary updates use the serial SSM workflow instead of
replacing stateful hosts.

Pulumi event logs may contain provider inputs. The deployment facade removes stale logs before SST
and newly created logs immediately after SST, including failure and signal paths.
