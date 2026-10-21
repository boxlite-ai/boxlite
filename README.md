# BoxLite Micro-cloud (prototype)

Control plane for "one prompt → a full app on BoxLite Cloud", built on top of the
public BoxLite API and running inside a BoxLite Box. Spec: Notion "PRD：Micro-cloud".

| dir | what | language |
|---|---|---|
| `supervisor/` | runs inside every app Box: starts `[[service]]`s, health checks, gateway, log shipping, in-place builds | Go |
| `control-plane/` | API the CLI talks to, app reverse proxy, deployments, Neon, scheduler | TypeScript (Node 24) |
| `cli/` | `boxlite-app …` for coding agents | TypeScript |
| `agent/` | agent.md + skill handed to the agent | markdown |
| `deploy/` | scripts that put the control plane into a dev Box | shell |

Contracts between the parts: `docs/contracts.md`. Build log / decisions: `docs/decisions.md`.
