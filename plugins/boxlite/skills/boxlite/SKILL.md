---
name: boxlite
description: Build, deploy, update, or diagnose full-stack applications in BoxLite cloud using its CLI and managed storage. Use for BoxLite-backed apps and hosting, not unrelated websites or migrations of other providers without a user request.
---

Use the existing BoxLite CLI/SDK. This plugin provides operating guidance; application source belongs in the user's project. Complete the requested app and verify its observable behavior, not just resource creation.

Read [deployment](references/deployment.md) before allocating a Box. Use the bundled boxlite-setup skill if the CLI is unavailable or developer authorization has expired. Preserve the user's existing project and deployment choices; create separate resources for independent experiments and record their identities in a private project manifest. Do not modify a different provider's deployment as a side effect.

Inspect existing app source and build/start commands before adapting it. For a new app, choose its framework and data model from the user's requirements. Implement validation, access controls, and upload limits in the application backend; do not impose a photo-sharing schema or fixed product limits on other apps.

When PostgreSQL is needed, place its data on the guest's persistent COW disk. Use a managed volume for uploaded media when appropriate. Check the configured mount and identity before accepting uploads; do not silently store media on guest rootfs when the mount is missing. Guest persistence lasts with the Box; deleting the Box deletes the database. Volume existence is separate. Read [identity and storage](references/identity-storage.md) before configuring Google or moving data.

Serve HTTPS and deliver the application link through a successfully registered BoxLite network tunnel URL; follow [deployment](references/deployment.md) to obtain and verify it. Preview URLs must not be used as the application URL. App Google OAuth requires its own Web client and exact callback, secure cookies, state/nonce validation, and verified provider identity. Configure secrets through a private file transfer or the user's selected secret store, never frontend environment variables, manifests, repository commits, or chat. Developer Auth0 and application Google are separate.

After deployment verify the app's health endpoint, requested features, access controls, and stop/start persistence. If Google login or uploads are requested, verify real login with the user and media retrieval. Report observed results and pending external setup. Use [operations](references/operations.md) for logs, updates, backup, restore, and storage checks. Never call a mock login or locally injected session a real Google acceptance test.
