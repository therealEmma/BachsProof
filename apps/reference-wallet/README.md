# Reference wallet

The reference wallet is a small Express and Prisma application used to teach
payment correctness. It includes a deliberately unsafe webhook handler and a
corrected handler.

Use an isolated test database. Set `BACHS_WEBHOOK_SECRET` to test raw-body
signature verification. Set `DATABASE_URL` for the Prisma/PostgreSQL store, or
omit it only when using the explicit in-memory test harness.

For PostgreSQL, deploy the test schema before running the application:

```bash
pnpm --filter @bachsproof/reference-wallet db:migrate:deploy
```

BachsProof reads wallet state through an application-supplied verifier. The
wallet does not expose an inspection or reset endpoint. `BACHSPROOF_TEST_MODE=true`
enables the optional checkpoint controller used by the deterministic race
demonstration; do not set it in production.
