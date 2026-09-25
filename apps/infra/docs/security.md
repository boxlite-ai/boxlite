## TL;DR

Keep bootstrap, deployment and runtime identities distinct, and follow the selected cloud’s access rules.

# Infrastructure security

[Infrastructure index](../README.md)

| Cloud | Guide |
| --- | --- |
| AWS | [IAM boundaries and shared grants](aws/security.md) |
| GCP | [Project IAM, service accounts and private ingress](gcp/security.md) |

## Configuration and secret handling

mstage encrypts the stage map; its key and deployment state use the selected cloud’s stores. Required/optional groups in `mstage.env.json` govern which
values a consumer receives. The ignored stage declaration is carried through a GitHub variable and
must not contain secret values. See [configuration](configuration.md).

`env list` reports names. `--values` and `--json` reveal values; write secrets through stdin and avoid
shell tracing. Runtime delivery may place values in resource definitions or encrypted Pulumi state;
a secret's storage encryption is not a claim that every downstream representation hides it.
Use the platform secret-reference channel only where the consumer supports it and has read access.

Preserve state encryption keys and object versions needed for recovery. Never rotate a Pulumi
passphrase by simply replacing the stored value: existing state must remain decryptable.

## Resource and rollout protection

mdeploy requires confirmation for protected apply/refresh and refuses protected-stage removal.
Runner resources independently prevent replacement/deletion and ignore boot-image/startup changes.
Use the selected cloud’s [runner guide](runners.md) to verify convergence.
Database protection, backups and availability are explicit stage settings, not implied by the name `prod`.


Source: [mdeploy guards](../mdeploy/src/run.ts).
