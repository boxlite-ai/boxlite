import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, test } from "vitest";

describe("default runtime initialization errors", () => {
  test("schema mismatch is catchable and retriable", () => {
    const homeDir = mkdtempSync(join(tmpdir(), "boxlite-default-error-"));

    try {
      const dbDir = join(homeDir, "db");
      const dbPath = join(dbDir, "boxlite.db");
      mkdirSync(dbDir);

      execFileSync(
        "python3",
        [
          "-c",
          `
import datetime
import sqlite3
import sys

with sqlite3.connect(sys.argv[1]) as connection:
    connection.execute("""
        CREATE TABLE schema_version (
            id INTEGER PRIMARY KEY CHECK (id = 1),
            version INTEGER NOT NULL,
            updated_at TEXT NOT NULL
        )
    """)
    connection.execute(
        "INSERT INTO schema_version (id, version, updated_at) VALUES (1, ?, ?)",
        (2_147_483_647, datetime.datetime.now(datetime.timezone.utc).isoformat()),
    )
`,
          dbPath,
        ],
        { timeout: 10_000 },
      );

      const sdkUrl = pathToFileURL(join(process.cwd(), "dist/index.js")).href;
      const child = spawnSync(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          `
import { rmSync } from "node:fs";
import { join } from "node:path";
import { JsBoxlite } from ${JSON.stringify(sdkUrl)};

try {
  JsBoxlite.withDefaultConfig();
  throw new Error("schema mismatch must throw");
} catch (error) {
  if (!(error instanceof Error)) throw error;
  if (error.message === "schema mismatch must throw") throw error;
  if (!error.message.includes("Schema version mismatch")) throw error;
  if (!error.message.includes("Upgrade this SDK to a compatible version")) throw error;
  if (!error.message.includes("use a new BOXLITE_HOME")) throw error;
  if (!error.message.includes("existing boxes, images, and caches will be unavailable")) throw error;
  console.log("CAUGHT_SCHEMA_MISMATCH");
}

rmSync(join(process.env.BOXLITE_HOME, "db", "boxlite.db"));
const first = JsBoxlite.withDefaultConfig();
const second = JsBoxlite.withDefaultConfig();
first.close();
second.close();
console.log("RETRY_SUCCEEDED");
`,
        ],
        {
          env: { ...process.env, BOXLITE_HOME: homeDir },
          encoding: "utf8",
          timeout: 30_000,
        },
      );

      expect(child.status, child.stderr).toBe(0);
      expect(child.stdout).toContain("CAUGHT_SCHEMA_MISMATCH");
      expect(child.stdout).toContain("RETRY_SUCCEEDED");
      expect(child.stderr).not.toContain("panicked at");
      expect(child.stderr).not.toContain("fatal runtime error");
    } finally {
      rmSync(homeDir, { recursive: true, force: true });
    }
  });
});
