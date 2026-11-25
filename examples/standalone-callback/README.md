# Standalone callback example

This directory is intentionally outside the pnpm workspace. After running `pnpm pack:check` from the repository root, run `pnpm install` here. Its dependencies point at the generated npm archives, so the test imports package exports rather than monorepo source files.

The test demonstrates callback verification and does not require a BachsProof
inspection endpoint in the application.
