# Node SDK agent instructions

## package-lock.json

Committed, and CI installs it with `npm ci`. Two constraints when it changes:

- **Regenerate under Node 18**, the floor of `engines.node`. npm selects
  manifests by `engines`, so Node 22 resolves vite 8 (which pulls rolldown,
  importing `styleText` from `node:util`) and the Node 18 CI leg then dies at
  vitest startup. Resolved under Node 18, vite stays on 6 and the unit suite
  passes on 18, 20 and 22. Node 18 still warns EBADENGINE for vitest itself,
  whose `engines` exclude it — that predates the lockfile and is unchanged.
- **The local build flow dirties it.** `npm run artifacts` creates `npm/<target>/`,
  which `workspaces: ["npm/*"]` pulls in, so a later `npm install` adds those
  entries. Restore the file (`git checkout -- sdks/node/package-lock.json`)
  before committing; only dependency changes belong in the diff.
