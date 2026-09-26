## TL;DR

Guest service previews require a public box and an active tunnel declaration, regardless of URL form.

## Problem

The proxy checks declarations for direct public hosts, but a signed host resolves through authentication and bypasses that check. Authenticated private previews also reach guest ports without a declaration. Both paths conflict with the desired service-port policy.

## Approach

- After resolving the box ID, require a public box and an active tunnel for every HTTP/WebSocket guest service port. Keep port 22222 on its existing authenticated terminal path.
- Reuse the API's existing public tunnel check, already used by raw CONNECT (`apps/proxy/pkg/proxy/tunnel.go:47`). The API check confirms both the active declaration and public box state (`apps/api/src/box/services/tunnel.service.ts:50`).
- Resolve signed hosts before checking the declaration. Do not trust the initial public lookup for a signed token as the box's visibility.
- Keep the URL APIs compatible; the proxy is the enforcement boundary, including for URLs issued before this change.
- Update proxy documentation and focused tests for direct, signed, private, terminal, and revoked access.

## Alternatives and trade-offs

Checking declarations while issuing URLs would leave old or manually constructed URLs accessible and cannot enforce revocation. Disabling signed preview URL issuance would also disrupt the Dashboard terminal, which uses port 22222. Rechecking the API for each service request costs one control-plane call, as the existing direct-host gate already does, but avoids stale positive authorization.

## Validation

Run focused proxy tests with production code reverted to capture the old bypass, then restore the fix and rerun. Check the proxy package through the repository's Make target. Confirm the final branch diff and preserve the local terminal flow.
