# Node SDK agent instructions

## package-lock.json

Committed, and CI installs it with `npm ci`. `make lint:node` — which the
pre-commit hook and the lint workflow both reach — checks it against
`package.json` and rejects generated `npm/*` workspace entries, so run
`npm install` here whenever you change a dependency.

**Regenerate under Node 18**, the floor of `engines.node`; nothing enforces
this, so it is on you. npm selects manifests by `engines`, so Node 22 resolves
vite 8 (which pulls rolldown, importing `styleText` from `node:util`) and the
Node 18 CI leg then dies at vitest startup. Resolved under Node 18, vite stays
on 6 and the unit suite passes on 18, 20 and 22. Node 18 still warns
EBADENGINE for vitest itself, whose `engines` exclude it — that predates the
lockfile and is unchanged.
