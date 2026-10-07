import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/*/test/**/*.test.ts", "apps/*/test/**/*.test.ts"],
    // apps/api runs inside workerd via its own config (`pnpm --filter api test`).
    exclude: ["**/node_modules/**", "apps/api/**"],
  },
});
