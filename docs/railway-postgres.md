# Railway PostgreSQL

The reference wallet accepts a standard PostgreSQL `DATABASE_URL`, so Railway's externally reachable connection string works without Docker Desktop or a local PostgreSQL installation. Keep the URL in an environment variable; `.env.example` contains only a placeholder.

Create a dedicated Railway database for tests, then run:

```powershell
$env:DATABASE_URL="postgresql://USER:PASSWORD@HOST:PORT/railway?sslmode=require"
pnpm --filter @bachsproof/reference-wallet db:generate
pnpm --filter @bachsproof/reference-wallet db:migrate:deploy
pnpm test:postgres
```

The database integration suite uses unique payment references and customer IDs. Its cleanup deletes only those references and their named test wallets, and only when no remaining credit points at a wallet. Cleanup is scoped to records created by the test run.

If `DATABASE_URL` is absent, the suite is skipped. If the URL is unreachable or the schema is missing, the suite reports the actual error and skips its PostgreSQL cases; the regular unit/in-memory tests remain usable. This avoids claiming database coverage that did not run.
