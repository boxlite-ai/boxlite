import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    globals: true,
    reporters: ["verbose"],
    coverage: {
      provider: "v8",
      include: ["lib/**/*.ts"],
      reporter: ["text", ["lcov", { projectRoot: "../.." }]],
      reportsDirectory: "../../target/coverage/node",
    },
    projects: [
      {
        extends: true,
        test: {
          name: "unit",
          include: ["tests/**/*.test.ts"],
          exclude: ["tests/**/*.integration.test.ts"],
        },
      },
      {
        extends: true,
        test: {
          name: "integration",
          include: ["tests/**/*.integration.test.ts"],
          setupFiles: ["tests/integration-setup.ts"],
          fileParallelism: false,
          testTimeout: 120_000,
          hookTimeout: 120_000,
        },
      },
    ],
  },
});
