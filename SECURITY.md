# Security Policy

BoxLite is a sandboxing runtime, so the security of the project matters
to everyone running it. We take vulnerability reports seriously and
appreciate the time researchers spend finding and responsibly disclosing
issues.

## Reporting a Vulnerability

**Please do not open a public GitHub issue for security reports.** Public
issues are indexed immediately and give potential attackers a head start
before a fix is available.

Use one of the following private channels instead:

1. **Preferred — GitHub Private Vulnerability Reporting.** Submit a
   report via
   [github.com/boxlite-ai/boxlite/security/advisories/new](https://github.com/boxlite-ai/boxlite/security/advisories/new).
   This opens a private advisory visible only to the maintainers and to
   collaborators you invite. It is the fastest path, and it lets us
   coordinate a fix, request a CVE, and credit you — all from the same
   thread.
2. **Fallback — Discord.** If GitHub's advisory form is unavailable to
   you, send a direct message to a maintainer on our
   [Discord server](https://go.boxlite.ai/discord) and ask for a private
   channel. Do not post details in public channels.

When reporting, please include (as much as you can share):

- A description of the vulnerability and its impact.
- Step-by-step reproduction instructions or a proof-of-concept.
- Affected version(s), platform (macOS / Linux / WSL2), and
  architecture (x86_64 / aarch64).
- Any suggested mitigation or patch, if you have one.

## What to Expect

- **Acknowledgement:** we aim to acknowledge a report within 3 business
  days.
- **Triage:** we will work with you to confirm the issue, assess impact,
  and agree on a disclosure timeline — typically within 90 days of the
  initial report, shorter for actively exploited issues.
- **Fix and release:** we will prepare a patch, coordinate the release,
  and publish a GitHub Security Advisory (with a CVE where applicable).
- **Credit:** with your permission, we will credit you in the advisory
  and the release notes. Anonymous reports are also welcome.

We will keep you updated at each step. If you have not heard back after
an acknowledgement window, feel free to ping us on the same channel.

## Supported Versions

BoxLite is pre-1.0 and moves quickly. Security fixes land on `main` and
the latest published minor release. We do not back-patch older releases.

| Version | Supported          |
|---------|--------------------|
| 0.9.x   | :white_check_mark: |
| < 0.9   | :x:                |

## Scope

In-scope examples (highest priority):

- VM escape — guest code that escapes the libkrun / Hypervisor.framework
  / KVM boundary and reaches the host.
- Guest-to-host privilege escalation via the portal / gRPC / vsock
  surface or the shared filesystem.
- Jailer bypass — guest or shim processes escaping the seccomp /
  sandbox-exec / namespace jail.
- Image handling vulnerabilities that can corrupt the host (e.g. unsafe
  tar extraction, path traversal on rootfs prepare).
- Host-side memory safety bugs in the Rust core or FFI shims that are
  reachable from untrusted input.

Out of scope:

- Issues in dependencies that already have a public advisory and a
  scheduled upgrade in this repository — please link the advisory in a
  regular issue instead.
- Vulnerabilities requiring physical access to the host, a pre-existing
  root shell on the host, or a modified local build.
- Denial-of-service caused by running workloads that legitimately
  consume the resources the caller configured (e.g. setting a high
  memory limit and then allocating it).
- Typos, style issues, and non-security bugs — use a normal GitHub
  issue.

If you are not sure whether something is in scope, report it anyway and
we will triage.

## Safe Harbor

We support good-faith security research. If you follow this policy, we
will:

- Consider your research authorized under the relevant anti-hacking
  laws, and we will not pursue legal action for your report.
- Work with you to understand and resolve the issue before any public
  disclosure.
- Not ask for payment or waiving of credit as a condition of the fix.

Please make a good-faith effort to avoid privacy violations, data
destruction, and service disruption while researching. Only interact
with accounts and systems you own or for which you have explicit
permission.

## Published Advisories

| Advisory | Severity | Affected | Fixed in |
|----------|----------|----------|----------|
| [GHSA-g6ww-w5j2-r7x3](https://github.com/boxlite-ai/boxlite/security/advisories/GHSA-g6ww-w5j2-r7x3) — read-only volume remount bypass | Critical | `< 0.9.0` (all SDKs) | **0.9.0** |

If you run any boxlite SDK (PyPI, npm, Go, crates.io) or build from source
at a version **before 0.9.0**, upgrade to **0.9.0 or later**. There is no
workaround for affected versions.

---

Thanks for helping keep BoxLite and its users safe.
