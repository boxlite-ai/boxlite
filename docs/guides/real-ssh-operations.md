# Real SSH: rollout, CA rotation and rollback

Operational runbook for CA-based real SSH — short-lived OpenSSH user
certificates verified offline by `boxlite-guest` over the existing direct
tunnel.

**Ownership.** BoxLite Platform Operations / on-call executes and is
accountable for every step here, including rollback and emergency response.
Security approves rotation cadence, TTL limits, key permissions, emergency
replacement policy and destruction criteria. The Hosted API owner maintains the
signer adapter and its instrumentation; the Guest/Runner owner maintains trust delivery
and rollout verification. Providing a component does not transfer operational
responsibility.

## What this feature does, precisely

The Hosted API signs a short-lived OpenSSH **user certificate** binding one
public key to one organization, one box and the `root` login user. The guest
holds only CA **public** keys and verifies certificates locally — it never
calls the API to authenticate, so SSH keeps working when the control plane
does not.

Two properties drive every procedure below:

- **Trust is immutable for a VM generation.** It is delivered as a box create
  option and replayed verbatim by stop/start. A restart never picks up a new CA
  set. Changing trust requires recreating or replacing the box.
- **Revocation is TTL-bounded.** `DELETE` marks the credential revoked and
  removes it from the active list immediately, but a certificate already issued
  stays valid for new sessions until `expires_at`, and live sessions are not
  terminated. There is no KRL and no online check. The 5-minute default TTL is
  what bounds the window — do not describe revocation as immediate.

## Default-off gates

Both sides fail closed, independently:

| Gate | Default | Effect when off |
|---|---|---|
| `SSH_CERTIFICATE_ISSUANCE_ENABLED` (API) | `false` | `POST .../ssh-access/certificates` returns `SSH_CERTIFICATE_ISSUANCE_DISABLED`; nothing is signed |
| `guest_ssh_trust` box option | absent | `boxlite-guest` starts no SSH listener at all |

A box created without a trust bundle has no SSH port. A deployment without
issuance enabled signs nothing. Turning on one without the other is safe and
inert.

## Rollout

Run in order. Each step is verifiable before the next.

1. Ship the guest, canonical Box API, SDK and trust-delivery code with both
   gates off. Apply the **pre-deploy Expand** migrations
   (`pre-deploy/…-add-ssh-certificate-credential-migration.ts` and
   `pre-deploy/…-add-box-guest-ssh-trust-migration.ts`). Both are purely
   additive and leave `ssh_access` untouched.
2. In the same coordinated release, the Legacy SSH Token routes and all their
   internal/Dashboard callers are already deleted. The `ssh_access` table stays
   for rollback only.
3. Provision a CA signer for one organization in AWS KMS
   (`ECC_NIST_EDWARDS25519`), publish its public metadata, and confirm the
   private key appears in neither application config nor PostgreSQL.

   **This is the enablement switch.** Inserting the organization's `current`
   `organization_ssh_ca_key` row is what turns guest SSH on for it: from that
   moment every *newly created* box in that organization is given the trust
   bundle and boots a listener. There is no separate per-box flag, and callers
   cannot request or decline it. Existing boxes are unaffected — their VM
   generation is already fixed — and the organization also stops being served
   pre-warmed boxes, since those booted before their organization was known and
   carry no trust.
4. Create one disposable canary box in that organization and confirm it came up
   with the expected CA key IDs. Boxes created before step 3 keep no listener
   until they are replaced.
5. Enable issuance for the canary organization. Verify SSH, SFTP, isolation and
   expiry, and check the issuance/authentication logs (see Observability —
   metrics are not yet emitted).
6. Rehearse rotation on the canary by **recreating** it (see below). Do not
   treat stop/start as trust convergence.
7. Widen by recreating or replacing boxes per organization/region, watching
   signer and authentication logs — and the metrics named under Observability
   once they are implemented.
8. After soak and the rollback checkpoint, remove the old Gateway code/config
   and run the **post-deploy Contract** migration
   (`post-deploy/…-drop-legacy-ssh-access-migration.ts`).

## CA rotation

The order is not negotiable. Getting it wrong locks boxes out.

```text
create next key
  -> recreate/replace target boxes so they trust current + next
  -> verify the new VM generation reports both key IDs
  -> switch the signer to next
  -> wait at least max certificate TTL + clock skew
  -> recreate/replace boxes to next-only
  -> after the rollback/audit window, disable or destroy the old private key
```

CA keys live in the `organization_ssh_ca_key` table, one row per key, with
`status` in `current` / `next` / `retired`. A partial unique index allows at
most one `current` and one `next` per organization, so the sequence above is
enforced by the schema, not only by discipline. There is no API for these rows
— provisioning and status transitions are operator actions against the
database, paired with the KMS key they reference via `providerKeyRef`.

Verification between steps must use the guest's own report rather than
inference — a box still trusting only the retired key has not converged,
however long ago it was restarted.

The guest reports this over `Guest.Ping` as `ssh_listener_ready`,
`ssh_host_fingerprint` and `ssh_trusted_ca_key_ids`. **No operator-facing
surface exposes those fields yet**: the host-side caller
(`src/boxlite/src/portal/interfaces/guest.rs`) discards the response, and no
CLI, REST or SDK path returns them. Until one exists, rotation convergence has
to be established from the guest's boot log, which records the trusted CA key
IDs — plan for that before starting a rotation, not during one.

Never destroy a CA while unexpired certificates it signed still exist, or while
it is needed for an audit investigation.

## Observability

> **Not yet implemented.** The metric families below are the agreed contract
> for this feature, not something the current build emits: none of them is
> produced anywhere, and the guest has no metrics facility at all. (The Hosted
> API does have telemetry modules, but nothing in them reports SSH
> certificates.) Treat this section as the specification instrumentation must
> satisfy, and do not write alerts against it until the metrics exist. What the
> current build *does* give you is the structured logging described at the end
> of this section.

Metric families to emit:

- `boxlite_ssh_certificate_issue_total{result,ca_key_id}`
- `boxlite_ssh_certificate_issue_duration_seconds`
- `boxlite_ssh_certificate_active{organization}`
- `boxlite_ssh_auth_total{result,reason,ca_key_id}`
- `boxlite_ssh_session_active`, `boxlite_ssh_session_duration_seconds`
- `boxlite_ssh_sftp_operation_total{operation,result}`
- `boxlite_ssh_ca_trust_mismatch_total`
- guest connection/channel/handle limit rejections

`reason` on auth failures is a fixed, low-cardinality vocabulary. The
certificate verifier emits `wrong_login_user`, `not_user_certificate`,
`unsupported_key_algorithm`, `untrusted_ca_or_invalid_signature`,
`outside_validity_window`, `principal_mismatch`,
`unrecognized_critical_option`; the connection handler additionally emits
`raw_public_key` when a bare key is offered. Nothing derived from a presented
certificate is logged, so a rejected peer cannot enumerate valid credentials.

Alerts to define once those metrics land: sustained signer/KMS failure;
auth-failure or unknown-CA rates departing from baseline; a guest reporting a
CA key set inconsistent with the intended rollout; resource-limit rejections or
session-leak signals; issuance latency or direct-tunnel SSH latency beyond SLO.

Until then, rollout verification relies on logs; read step 5 of the rollout
above that way.

**Never logged, anywhere:** private keys of any kind, raw public keys or
certificate bodies, full SSH command lines, file contents, environment
variables. Log credential ID, box ID, organization ID, CA key ID, serial,
fingerprint, TTL, result and stable error code.

## Rollback

Before the Contract migration:

1. Disable certificate issuance first.
2. Keep CA public trust in place until every issued certificate has expired —
   pulling trust early breaks sessions that are still legitimately valid.
3. For newly recreated boxes, disable the guest listener via replacement
   config. Existing VM generations keep their original immutable config until
   they are themselves replaced.
4. Roll back application code together with its internal callers. `ssh_access`
   still exists at this point.

After the Contract migration, prefer roll-forward. Rollback must not restore
token authentication, and the dropped rows are not recoverable — that is the
accepted cost of the checkpoint, not an oversight.

## Failure modes worth recognizing

| Symptom | Likely cause | Action |
|---|---|---|
| `503 SSH_CA_UNAVAILABLE` | Signer/KMS unreachable or throttled | Check KMS health; no credential row was created |
| Auth fails with `untrusted_ca_or_invalid_signature` after a signer switch | Boxes not yet recreated onto current+next | Recreate before switching, not after |
| Auth fails with `outside_validity_window` fleet-wide | Host/guest clock drift | Check NTP; do not extend `validBefore` to compensate |
| Revoked credential still connects | Expected, TTL-bounded | Wait for `expires_at`; shorten the TTL policy if intolerable |
| Host fingerprint changed after restart | Guest root filesystem was not preserved | Investigate; a changed fingerprint is indistinguishable from interception |
