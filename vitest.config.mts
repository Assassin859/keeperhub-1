import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["**/*.test.ts", "**/*.test.tsx"],
    exclude: [
      "node_modules",
      ".next",
      "tests/e2e/playwright",
      ".pnpm-store",
      ".worktrees",
      "**/.worktrees/**",
      // keeperhub-events is a separate pnpm workspace with its own
      // vitest config and dependencies. Without this exclude,
      // `pnpm test:integration tests/integration` from the main app
      // picks up keeperhub-events/event-tracker/tests/integration via
      // positional path filter and fails on missing deps.
      "keeperhub-events/**",
      // .planning/ contains hackathon archives with frozen forks of the
      // codebase + their stale test snapshots. Including them in vitest
      // means any change to a baseline (like BASELINE_POLICIES) breaks
      // archived test files that no longer match the live source.
      ".planning/**",
    ],
    coverage: {
      provider: "v8",
      reporter: ["text", "json", "html"],
      include: ["lib/**/*.ts", "app/api/**/*.ts", "scripts/**/*.ts"],
      exclude: ["**/*.test.ts", "**/*.d.ts"],
    },
    setupFiles: ["./tests/setup.ts"],
    testTimeout: 10_000,
    fileParallelism: false,
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./"),
    },
  },
});
