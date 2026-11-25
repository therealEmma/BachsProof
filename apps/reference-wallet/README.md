# Reference wallet

Express 5 reference application with `vulnerable` and `corrected` Bachs webhook handlers. Set `BACHS_WEBHOOK_SECRET` to enable the official SDK's raw-body signature verification. Set `DATABASE_URL` to use the Prisma/PostgreSQL store; omit it only for the explicit in-memory test harness.

The test endpoints are disabled unless `PAYPROOF_TEST_MODE=true` and a non-empty `PAYPROOF_TEST_SECRET` is configured. The global PostgreSQL reset endpoint additionally requires `PAYPROOF_ALLOW_DESTRUCTIVE_RESET=true`; Railway integration tests use scoped cleanup instead.

Run `pnpm --filter @payproof/reference-wallet db:migrate:deploy` against the dedicated `DATABASE_URL` before starting the server. The application can be verified through PayProof's callback API, so consumers do not need to expose `/__payproof/state`.
