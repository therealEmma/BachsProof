# Bachs integration boundary

BachsProof now has two deliberately separate Bachs paths:

- `@bachsproof/bachs` mock mode emits deterministic local fixtures using the documented Bachs webhook envelope. The payloads are synthetic and do not claim to be sandbox deliveries.
- The reference wallet accepts the documented `checkout.completed`, `checkout.expired`, `collection.succeeded`, `collection.underpaid`, and `collection.failed` event names. It uses the official Node SDK `webhooks.constructEvent` helper when `BACHS_WEBHOOK_SECRET` is configured.

The webhook route reads the original raw bytes before parsing. The SDK verifies `X-Bachs-Signature-V2`, the timestamp tolerance, and any matching `v1` signature during secret rotation. The application then validates the event envelope with Zod and persists event identity separately from financial idempotency.

## Verified Bachs behavior used here

The implementation follows the official documentation:

- Money is a decimal string paired with an ISO currency, never a JavaScript number.
- `checkout.completed` can occur without a collected payment; only a completed payment checkout with `payment_status: "paid"` and a charge is eligible here.
- `checkout.completed` and `collection.succeeded` can both refer to one checkout/payment and can arrive in either order.
- `collection.succeeded` carries uppercase event statuses. This wallet only fulfils `SUCCEEDED`; `ACCEPTED` and `OVERPAID` require an explicit business policy and are treated as non-fulfilling by this demonstration.
- `checkout.expired` is not treated as final because a later completion can still arrive; it never creates a credit by itself.
- Event IDs are delivery identities. A Bachs charge/payment identity or local checkout reference is the business idempotency identity.

`collection.underpaid` is modeled with its documented `amount_paid`,
`amount_expected`, `amount_remaining`, `currency`, `status`, reference, and
checkout/charge identifiers. It remains non-fulfilling until a later eligible
success. `collection.failed` is also modeled as non-fulfilling because the
checkout can remain open for another attempt.

The complete reusable scenario set is documented in
[`docs/scenarios.md`](./scenarios.md). The lifecycle and rejection fixtures are
synthetic and intentionally do not claim to be provider-generated deliveries.

The project does not create checkout sessions, call live payment APIs, forward real sandbox events, or use live credentials. Sandbox acceptance and production behavior remain unverified in this repository.

## Official references

- [Bachs webhook setup and signature verification](https://docs.bachs.io/guides/webhooks/overview)
- [`checkout.completed` event](https://docs.bachs.io/guides/webhooks/events/checkout-completed)
- [`collection.succeeded` event](https://docs.bachs.io/guides/webhooks/events/collection-succeeded)
- [`checkout.expired` event](https://docs.bachs.io/guides/webhooks/events/checkout-expired)
- [Official Node.js SDK](https://docs.bachs.io/sdks/node)
- [Official SDK source](https://github.com/bachsdev/bachs-node)
