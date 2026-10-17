/**
 * Registries the integration runtime resolves images against.
 *
 * `make test:integration:node` runs vitest under `with-local-registry`, which
 * sets `BOXLITE_TEST_REGISTRY` to a registry on 127.0.0.1 that replays
 * recorded images (src/boxlite/tests/README.md). Run without it, the suite
 * fails harness-registry.integration.test.ts and pulls through public mirrors,
 * kept in sync with sdks/python/tests/conftest.py.
 */
export function testRegistries() {
  const local = process.env.BOXLITE_TEST_REGISTRY;
  if (local) {
    return [{ host: local, transport: "http", search: true }];
  }
  return [
    { host: "docker.m.daocloud.io", search: true },
    { host: "docker.xuanyuan.me", search: true },
    { host: "docker.1ms.run", search: true },
    { host: "docker.io", search: true },
  ];
}
