# BachsProof v2 product brief

BachsProof is a focused financial correctness testing tool for developers
integrating Bachs.

**Tagline:** Beyond webhook delivery. Verify financial correctness.

## Product promise

Install one package, generate one config file, implement two callbacks, and run
five default local simulated payment scenarios. Six additional scenarios are
available when an integration supports their provider events. BachsProof signs each webhook,
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

### Default scenarios

1. Sequential duplicate webhook
2. Concurrent duplicate credit
3. Concurrent unique payments
4. Incorrect payment amount
5. Incorrect payment currency

### Optional scenarios

6. Cross-event duplicate payment
7. Out-of-order events
8. Checkout completed without payment
9. Expired checkout
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
