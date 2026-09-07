import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

// Tests run inside workerd with the bindings from wrangler.jsonc (a local D1
// plus the static assets). Files share one database, so they run one at a time.
export default defineConfig({
  plugins: [cloudflareTest({ wrangler: { configPath: "./wrangler.jsonc" } })],
  test: {
    include: ["test/**/*.test.ts"],
    fileParallelism: false,
  },
});
