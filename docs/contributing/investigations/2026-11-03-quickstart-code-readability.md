## TL;DR

Make SDK/CLI quickstart code readable and remove fixed dependency versions from its installation commands.

## Problem and scope

OnboardingGuideDialog's QuickstartCode applies text-label: Tailwind defines it as 10px with 0.12em letter spacing. The same style reaches command and key displays. Code should preserve indentation and use normal monospaced spacing. Limit changes to this walkthrough; preserve the shared CodeBlock defaults for other pages.

## Related work and lessons

Inspected main commit 30a7c982:

- [Quickstart rendering](https://github.com/boxlite-ai/boxlite/blob/30a7c982/apps/dashboard/src/components/OnboardingGuideDialog.tsx#L436-L450) applies text-label to code. The inline walkthrough uses the same renderer.
- [Type scale](https://github.com/boxlite-ai/boxlite/blob/30a7c982/apps/dashboard/tailwind.config.js) defines text-label as 10px with 0.12em tracking.
- [Shared renderer](https://github.com/boxlite-ai/boxlite/blob/30a7c982/apps/dashboard/src/components/CodeBlock.tsx) accepts codeAreaClassName, so reuse it rather than introduce another highlighter.
- [Interface registry](https://github.com/boxlite-ai/boxlite/blob/30a7c982/apps/dashboard/src/lib/quickstart/interfaces.json) drives both visible and copied install commands. Change the source instead of UI-only substitutions.

Adopt scoped typography to preserve other pages' compact code styles. Reject global font changes and a new renderer because they expand scope without improving this walkthrough. Reject replacing one fixed package version with another because the requirement is unpinned installation.

Official GitHub release metadata was read with gh api repos/boxlite-ai/boxlite/releases/latest. C assets contain the tag in their name, so latest/download alone cannot remove the embedded version. Resolve the latest release redirect at execution, extract its tag, and reuse the existing platform-specific artifact pattern. This adds no jq dependency. Keep the existing supported-platform choices.

## How it works

Use a quickstart-scoped code typography class: existing mono font, 14px, 24px line height, normal tracking, no ligatures, preserved whitespace and horizontal scrolling. Increase bounded code height to 420px and group file/terminal titles with copy actions above code. Improve prose to 14px and step headings to 16px using the existing theme. Apply consistent typography to inline and dialog paths, including lazy fallbacks.

Remove pins from pip/npm/go/cargo installs and the browser recipe's Playwright installation. Resolve the C release tag dynamically. CLI and REST have no dependency pins to remove.

## Validation

The installation regression failed against the original pinned commands before production edits. After implementation, the focused Make dashboard checks passed 35 tests, including clipboard content. All seven installation blocks passed bash syntax checks. Browser inspection covered light/dark themes, all seven language tabs, desktop and 390px layouts; rendered code measured 14px/24px with normal tracking and no page overflow. No SDK installation or production deployment was performed. SDK runtime compatibility with whichever release users later install remains separate from the UI change.
