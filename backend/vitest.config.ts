import { defineConfig } from "vitest/config";

/**
 * Unit tests run with `npm test` and never touch Postgres/Redis/network.
 * Integration tests (`*.integration.test.ts`) talk to real infra and run with
 * `npm run test:integration`, which requires TEST_DATABASE_URL / TEST_REDIS_*.
 */
export default defineConfig(({ mode }) => {
  const integration = mode === "integration";

  return {
    test: {
      environment: "node",
      include: integration ? ["src/**/*.integration.test.ts"] : ["src/**/*.test.ts"],
      exclude: integration
        ? ["**/node_modules/**", "**/dist/**"]
        : ["**/*.integration.test.ts", "**/node_modules/**", "**/dist/**"],
      // Integration suites share one database and one Redis instance.
      fileParallelism: !integration,
      testTimeout: integration ? 60_000 : 10_000,
      hookTimeout: integration ? 60_000 : 10_000,
    },
  };
});
