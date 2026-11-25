# Standalone callback example

This directory is intentionally outside the pnpm workspace. After running `pnpm pack:check` from the repository root, run `pnpm install` here. Its dependencies point at the generated npm archives, so the test imports package exports rather than monorepo source files.

The test demonstrates Level 2 callback verification and does not configure an HTTP financial-state endpoint.
