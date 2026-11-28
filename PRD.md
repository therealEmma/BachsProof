# BachsProof v2 product brief

BachsProof is a focused financial correctness testing tool for developers
integrating Bachs.

**Tagline:** Beyond webhook delivery. Verify financial correctness.

## Product promise

Install one package, generate one config file, implement two callbacks, and run
eleven local simulated payment scenarios. BachsProof signs each webhook,
delivers it to an isolated application, reads committed financial records, and
checks five financial invariants.

It never calls Bachs, moves money, deletes application data, or claims that a
finite test window can prove a future credit will never happen.

## Public workflow

```bash
pnpm add -D @bachsproof/cli
pnpm exec bachsproof init
pnpm exec bachsproof test
```

The config contains `webhookUrl`, a test-only `secret`, `amountMinor`,
`currency`, `createPayment()`, and `verify()`. Optional settings are limited to
selecting scenarios and extending asynchronous verification time.

## Supported scenarios

1. Sequential duplicate webhook
2. Concurrent duplicate credit
3. Concurrent unique payments
4. Cross-event duplicate payment
5. Out-of-order events
6. Incomplete checkout
7. Expired checkout
8. Incorrect payment amount
9. Incorrect payment currency
10. Underpaid payment
11. Failed payment

## Financial invariants

The v2 runner preserves `INV-001` through `INV-005`: unique credit, amount
integrity, completion, no unexpected credit, and aggregate integrity.

## Scope boundaries

The active workspace contains `@bachsproof/cli`, `@bachsproof/core`, and
`@bachsproof/bachs`. The old SDK, checkpoints, race controllers, replay paths,
synthetic-reference fallback, delivery-only mode, and standalone security
scenarios are not v2 features. The v1.1.0 release remains available and is
described in the migration guide.
