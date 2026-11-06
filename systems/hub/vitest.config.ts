import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersConfig({
  test: {
    // Guarantee .dev.vars (the dev TOKEN) exists: it is gitignored, so
    // fresh checkouts used to 401 through the whole suite (2026-11-06).
    globalSetup: "./test/global-setup.ts",
    poolOptions: {
      workers: {
        wrangler: { configPath: "./wrangler.jsonc" },
        // Isolated storage mis-handles SQLite-backed DOs (stray -shm
        // files trip its assertions); tests share storage until the
        // change-log suite needs per-test isolation.
        isolatedStorage: false,
      },
    },
  },
});
