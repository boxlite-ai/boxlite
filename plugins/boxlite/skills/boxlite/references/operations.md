# Operate a deployed app

Use the private project manifest to select the exact Box, volume, guest directory, and app-specific service commands. A profile belongs to the host CLI and is not copied into the guest. Check Box state, service status, and the app's health endpoint before changing configuration.

Inspect bounded log tails and redact incidental secrets before presenting them. A login error can be application OAuth setup, an expired developer session, or an Auth0 grant problem; identify which layer failed before changing settings.

To stop, shut down guest services cleanly before stopping the Box. To restart, start the same Box and invoke its recorded service startup commands. Do not create a replacement to recover an idle proxy URL. Starting a Box does not prove the app starts automatically: verify its startup mechanism and health endpoint. For a missing media mount, inspect attachment and identity while preserving files and database.

Stage updates, verify artifacts, and preserve persistent data and private configuration. Check health and the requested features after deploying. Keep a rollback path for application files and account for schema compatibility before applying database migrations.

For PostgreSQL, use `pg_dump` custom format and back up media separately to the user's durable backup destination. Quiesce writes when a consistent database/media pair is required, and record checksums. A backup on the same guest is not disaster recovery. Back up application OAuth configuration through a private secret destination.

Restore into an isolated Box and volume with matching schema/roles, configure the restored storage identity, and verify media checksums and relational references. Do not overwrite live data without authorization for that destination. Mark restoration unverified until a rehearsal passes; successful backup creation alone does not prove recovery.
