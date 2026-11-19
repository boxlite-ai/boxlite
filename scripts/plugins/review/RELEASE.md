# BoxLite 0.2.0 release candidate

## Listing copy

**Name:** BoxLite

**Short description:** Run cloud or local sandboxes.

**Description:** Create isolated Linux sandboxes, run commands, transfer reviewed files, and update applications while retaining Box identity and data. Choose Cloud OAuth or Cloud API key through the same BoxLite MCP service, or use an independent local runtime.

API-key setup requires a native host with private MCP configuration; Local requires shell execution and virtualization. OAuth cannot create public tunnels.

**Category:** Developer Tools

**Publisher:** BoxLite, subject to the submitting organization's identity verification.

**MCP URL:** `https://api.boxlite.ai/mcp`

**Repository:** https://github.com/boxlite-ai/boxlite

**Plugin folder:** `plugins/boxlite`

**Website:** https://boxlite.ai

**Support:** https://boxlite.ai/contact

**Privacy:** https://boxlite.ai/legal/privacy

**Terms:** https://boxlite.ai/legal/terms

**Icon:** `assets/boxlite-icon.png` inside the plugin archive, 512 × 512 PNG.

## Changes from 0.1

- Adds an explicit three-mode setup workflow and one shared cloud MCP declaration.
- Replaces cloud CLI deployment helpers with host MCP instructions; preserves native CLI execution for Local only.
- Adds a local launcher that removes inherited cloud routing, rejects credential-bearing runtime homes and routing overrides, and preserves subprocess exit codes.
- Adds reproducible plugin and standalone marketplace archives, exact package inventory checks, and review materials.

Existing Boxes and private deployment state are not migrated, executed, or removed automatically.
After upgrading, explicitly select and verify the intended backend and organization before operating existing resources.
Uninstalling the plugin does not remove Boxes, volumes, runtime homes, or independently configured API-key connections.

## Data handling

Cloud tool arguments, commands, and selected file archives are sent to the declared BoxLite service.
Local execution uses the user's host; requested image pulls and guest commands can contact their configured networks.
OAuth tokens stay with the host and API keys stay in the user's private environment; the plugin has no separate telemetry or token store.

## Release status

This is a release candidate, not an approved directory listing.
Package validation does not establish OAuth availability, local VM execution, server compliance, or portal approval.
Complete the accompanying checklist with observed evidence before review submission.
