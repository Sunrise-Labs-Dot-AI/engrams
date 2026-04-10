import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    testTimeout: 60_000,
    pool: "forks",
    sequence: { concurrent: false },
    include: ["src/__evals__/**/*.eval.ts"],
    exclude: ["node_modules", "dist"],
  },
});
