# `@bachsproof/cli`

The command-line way to test a Bachs webhook.

Install it in the application repository that owns the webhook:

```bash
pnpm add -D @bachsproof/cli@1.1.0
pnpm exec bachsproof init
pnpm exec bachsproof test --name "sequential duplicate webhook"
```

`init` creates a configuration, the 15 scenario definitions, a payment setup
callback, and a financial verification callback. The last two files fail with a
clear message until you connect them to your isolated test data. This is
intentional: BachsProof must not pretend that it verified money when it did not
read your database.

## What you configure

- `bachsproof.config.mjs` points to the running test application and connects
  the callbacks.
- `tests/bachsproof.setup.mjs` creates a fresh payment or order and returns its
  reference.
- `tests/bachsproof.verify.mjs` reads the committed payment and credit state.
- `tests/bachsproof.test.mjs` selects scenarios and their test amounts.

The target application needs only its normal webhook route. It does not need a
BachsProof route or a production-only inspection endpoint.

## Commands

```bash
pnpm exec bachsproof init
pnpm exec bachsproof init --force
pnpm exec bachsproof test
pnpm exec bachsproof test --name "underpaid payment"
pnpm exec bachsproof test --json > bachsproof-results.json
```

Use `--force` only when replacing generated files is intentional. Use
`requireFinancialVerification: true` when CI must fail unless `verify()` read
committed financial state.

The normal runner sends local, Bachs-shaped test events. It does not call the
Bachs API and does not need a Bachs API key. Keep the target URL, test database,
and signing secret isolated from production.

For a complete setup, read the [quickstart](../../docs/quickstart.md). For
programmatic use, read the [programmatic API guide](../../docs/advanced/programmatic-api.mdx).
