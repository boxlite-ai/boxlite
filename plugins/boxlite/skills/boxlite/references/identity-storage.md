# Identity and durable data

The BoxLite developer account uses Auth0 for CLI/cloud authorization. An application's users authenticate with that application's own identity provider and sessions. End users do not need BoxLite accounts. Do not share the developer access token with a generated application.

For application Google login, register its actual HTTPS origin and exact callback in a separate Google OAuth Web client. Configure consent and test users while in testing. Supply the client secret only to the application backend through a private file transfer or the selected secret store. Do not change the BoxLite platform's Auth0 Google connection to configure app login.

Use a maintained OAuth/OIDC library to validate state, nonce, signature, issuer, and audience. Verify email when the application's identity rules require it. Do not accept an unsigned browser profile as proof of identity. Use secure HttpOnly session cookies and appropriate CSRF protection for cookie-authenticated mutations. Keep user authorization in the backend and database.

When PostgreSQL is required, use the guest COW disk for its data and expose it only to the application through a private socket or network interface. A 10 GiB guest disk is an example allocation, not a plugin limit. Deleting a Box deletes its guest database. A managed media volume has a separate lifetime and does not increase guest database capacity.

For a small single-Box application, SQLite on the persistent guest disk can suffice; choose it from the app's concurrency and operational needs. Keep the database under the app's directory in `/home/boxlite`, use WAL when appropriate, and verify committed data after stop/start. `/tmp` is temporary storage: keep databases and retained uploads out of it. Use SQLite's backup API or quiesce writers before copying a live WAL database; copying only its main file can omit committed data.

For uploads, verify the expected managed volume mount and its recorded identity before accepting writes. A missing mount must not silently create a media directory on rootfs. Treat consistency and durability as provider behavior; do not promise filesystem semantics beyond actual tests. Define image/audio/video size limits, content validation, and public/private access from the application's requirements. Monitor guest disk headroom and volume capacity separately.
