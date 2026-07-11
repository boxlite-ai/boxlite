# Local Dex instances

Start the default environment as usual:

```bash
node apps/scripts/dev-dex.mjs
```

Start an additional headless environment with a predefined instance file:

```bash
node --env-file=apps/scripts/local-dex-instances/two.conf apps/scripts/dev-dex.mjs
node --env-file=apps/scripts/local-dex-instances/three.conf apps/scripts/dev-dex.mjs
```

Dex, the local registry, and runtime images are shared. Each instance file must
use a unique instance name and unique API, Postgres, Redis, runner API, and proxy
ports. Copy an existing file and change those values to add another instance.
