# Reviewer setup and submission runbook

## Package map

Upload `boxlite-0.2.0.zip` to OpenAI's plugin portal; do not upload this review-kit ZIP as the plugin.
Extract `boxlite-marketplace-0.2.0.zip` for native Codex and Claude Code installation using its absolute directory.
The marketplace includes both host catalogs and the shared plugin directory, with no external relative-path dependency.

For Claude's public directory, provide the public repository, release commit/tag, and `plugins/boxlite` folder.
Submit a companion connector for `https://api.boxlite.ai/mcp` under the same organization.
Record the exact published commit and archive hashes in the private readiness checklist.

## Reviewer access

Provision a dedicated test account and organization with usable quota and synthetic data.
Supply login instructions and credentials through the portal's private reviewer-access fields, including any required verification or MFA procedure.
Do not reuse a developer's API key or put tokens in this archive, source control, demo, or logs.

For OpenAI, configure OAuth to the declared endpoint and complete consent as that test user.
Verify the issuer's native client registration, token issuance, refresh, and permitted scopes before submitting.

Follow [OAuth acceptance](OAUTH.md) for staged prerequisites, account setup, negative checks, and evidence limits.
The public OpenAI submission flow has no API-key connection setup.
Do not label the protected endpoint unauthenticated or add headers to the public manifest.

For native Codex/Claude Code API-key testing, follow the packaged `cloud-auth.md` using a private environment reference.
Disable the unused OAuth connection or verify host deduplication, then prove missing/empty keys stop without using a cached OAuth identity.
For Local, use a supported virtualization-capable host and the packaged launcher; no cloud account is required.

## Eight review cases

Start each mode in a fresh session and complete P1 to verify its connection.
Run P2, P3, P4, and N2 in that session using the Box ID returned by P2; run N3 there for OAuth only.
Run P5 last to remove that Box, then retain evidence of expected outputs, errors, and cleanup.

For Local P2, choose an available host port and create the Box with `-p HOST_PORT:8000`; record the mapping alongside its ID.
This publishes on all host interfaces; follow the Local reference's firewall guidance before creation if access must be loopback-only.
In P4, bind the guest app to `0.0.0.0:8000` and verify `http://127.0.0.1:HOST_PORT` using that existing mapping and Box.

Run N1 separately after prior OAuth use, selecting API-key mode with a missing or empty key.
Inspect the live schemas before calling tools; the case list is not the execution order.
Five positive and three negative cases are definitions, not pre-recorded passing results.

Repeat the applicable lifecycle/file/update cases through both cloud credentials and through Local.
Record the actual tool namespace for cloud calls and launcher invocation for Local; a direct maintenance-client run alone does not establish agent skill behavior.
OAuth public-tunnel denial is expected and must not be replaced by an API-key call.

## File transfer prerequisites

Discover `uploadFiles` and `downloadFiles` on the existing service; do not require new preparation tools or a server deployment.
Use the Codex helper or the current Claude session’s transfer tools. Check that the receipt contains only completion metadata.

The host needs Python 3.9+, shell/filesystem access and access to the selected endpoint.

For Claude, verify the selected session exposes both BoxLite transfer tools.

Check completion and expected file placement, using binary data, a filename with spaces/non-ASCII characters and an empty directory.
Do not pre-create the download directory; the helper creates it.
Do not add a mandatory checksum or upload readback to the product workflow.

A fixture run establishes only the boundaries it actually exercised; record deployed-server and native OAuth results separately.

Codex loads its host configuration. Claude authorizes the operation with its two paths before local archive I/O, then sends the file-tool call over the selected connection.

API-key acceptance is not OAuth acceptance; verify the selected host's OAuth connection separately.

## Demo recording

Record installation, three-mode selection, OAuth consent, hello execution, a file roundtrip, an update preserving data, a failure without mode fallback, and scoped cleanup.
Show the separate API-key and Local workflows on hosts that support them, with credentials and private account details hidden.
Host the recording at a reviewer-accessible URL and place that URL in the portal and private checklist; no recording is supplied by this candidate archive.

## Portal checks

For OpenAI, verify publisher/domain, upload the MCP-containing ZIP, resolve metadata/skill/tool/authentication scans, provide the cases and reviewer access, and request review.
Confirm whether optional local execution needs desktop-only eligibility or a separate listing before claiming all three modes on the directory surface.
Upload and scan are distinct from review approval and publication.

For Claude, run the native validator, then the portal's repository validation and security scan, and resolve every blocking finding.
Review the companion connector's complete exposed tool set: readable titles, correct read/write hints, and separate tools for read and write operations are required.

A mixed read/write API catalog invoker cannot be made compliant solely by changing this plugin's skills or its description.
This candidate requires the deployed split `read_api_endpoint` and `write_api_endpoint` tools, with display titles and accurate hints.
If discovery still exposes the former mixed invoker, complete the API rollout before requesting directory review.

## Maintainer sign-off

Use `checklist.json` as the starting state; attach evidence and mark a gate passed only after observing it.
The private reviewer account, demo URL, owner verification, published release reference, and portal reports must be provided by the release owner.
Check hashes again after every package edit, and repeat the affected validation before submitting.

References: [OpenAI submission](https://developers.openai.com/plugins/deploy/submission), [OpenAI local execution](https://developers.openai.com/plugins/deploy/desktop-only), [Claude publishing](https://claude.com/docs/directory/publish), [Claude plugin checklist](https://claude.com/docs/plugins/pre-submission-checklist), [Claude connector checklist](https://claude.com/docs/connectors/building/review-criteria).
