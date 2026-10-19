import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersConfig({
  test: {
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
