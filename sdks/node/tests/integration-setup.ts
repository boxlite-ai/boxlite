/**
 * Vitest setup file for integration tests.
 *
 * Initializes the default BoxliteRuntime with a unique temp directory
 * to avoid lock contention with any running BoxLite process (e.g.,
 * boxlite-mcp). Follows the same pattern as test-utils/PerTestBoxHome.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { afterAll } from "vitest";
import { getJsBoxlite } from "../lib/native.js";

// Use /tmp/ (not os.tmpdir()) to keep Unix socket paths under macOS
// 104-char SUN_LEN limit. Same pattern as test-utils/PerTestBoxHome.
const testHome = mkdtempSync("/tmp/boxlite-test-node-");
const testRegistries = [
  { host: "docker.m.daocloud.io", search: true },
  { host: "docker.xuanyuan.me", search: true },
  { host: "docker.1ms.run", search: true },
  { host: "docker.io", search: true },
];

const Boxlite = getJsBoxlite();
Boxlite.initDefault({ homeDir: testHome, imageRegistries: testRegistries });

afterAll(async () => {
  try {
    // Get the default runtime and shut it down
    const runtime = Boxlite.withDefaultConfig();
    await runtime.shutdown();
  } catch {
    // Ignore shutdown errors during cleanup
  }
  rmSync(testHome, { recursive: true, force: true });
});
