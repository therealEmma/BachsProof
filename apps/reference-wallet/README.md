# Reference wallet

Express 5 reference application with `vulnerable` and `corrected` Bachs webhook
handlers. Set `BACHS_WEBHOOK_SECRET` to enable the official SDK's raw-body
signature verification. Set `DATABASE_URL` to use the Prisma/PostgreSQL store;
omit it only for the explicit in-memory test harness.

Run `pnpm --filter @payproof/reference-wallet db:migrate:deploy` against the
dedicated `DATABASE_URL` before starting the server. PayProof verifies the
wallet through an application-supplied callback, so the wallet does not expose
an inspection or reset endpoint. `PAYPROOF_TEST_MODE=true` only enables the
optional checkpoint controller used by deterministic race demonstrations.
