import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Other agents' worktrees under .cheapag hold stale copies of this repo's
    // tests; running them here fails on settings that no longer match.
    exclude: [...configDefaults.exclude, "**/.cheapag/**"],
  },
});
