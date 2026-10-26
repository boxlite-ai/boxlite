# BoxLite Micro-cloud (prototype)

Control plane for "one prompt → a full app on BoxLite Cloud", built on top of the
public BoxLite API and running inside a BoxLite Box. Spec: Notion "PRD：Micro-cloud".

| dir | what | language |
|---|---|---|
| `supervisor/` | runs inside every app Box: starts `[[service]]`s, health checks, gateway, log shipping, in-place builds | Go |
| `control-plane/` | API the CLI talks to, app reverse proxy, deployments, Neon, scheduler | TypeScript (runs on Node 22 in the Box) |
| `cli/` | `boxlite-app …` for coding agents | TypeScript |
| `agent/` | `SKILL.md` (the agent guide, served as `<cp>/agent.md` and embedded in the CLI) and `prompt-template.md` (the App prompt the console hands out) | markdown |
| `shared/` | code both the CLI and the control plane import: manifest parsing and checks, error and exit codes, failure diagnosis, redaction | TypeScript |
| `deploy/` | scripts that put the control plane into a dev Box | shell |
| `e2e/` | live suites (API, console) and real-agent acceptance | Node |
| `console-dist/` | build output of the dashboard's console (not committed), served at `/console/` | |

Deploy it in a fresh environment: `docs/deploy.md`. Start reading the code with `docs/architecture.md`. Wire formats: `docs/contracts.md`. Why: `docs/decisions.md`.
Findings from real runs and their status: `docs/polish-backlog.md`; code-level findings: `docs/code-health.md`; security findings and their fixes: `docs/security-review.md`. CLI: `docs/cli-reference.md` (generated).

Live on BoxLite dev: API `https://8080-d-76416e6f374b4352547a7a68.proxy.dev.boxlite.ai`,
console `https://8081-d-76416e6f374b4352547a7a68.proxy.dev.boxlite.ai/console/`.
