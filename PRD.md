# PayProof — Product Requirements Document

**Version:** 1.1  
**Status:** Approved for MVP development  
**Product:** Open-source payment correctness testing framework  
**Primary language:** TypeScript  
**Runtime:** Node.js 24  
**Initial payment provider:** Bachs  
**Distribution:** npm packages, with an optional CLI  
**MVP target:** One focused development session (approximately 6–8 hours)  
**Engineering showcase target:** 7–14 days, depending on implementation and testing complexity

> **Historical design note:** This document records the original product design.
> The current first-release implementation supersedes the early HTTP inspection
> and target-reset proposals: financial verification uses an application-owned
> callback, while payment preparation and cleanup remain application-owned. See
> [README.md](README.md) and the current CLI documentation for the supported
> public workflow.

---

# 1. Executive Summary

PayProof is an open-source TypeScript testing framework that helps developers identify and reproduce financial correctness bugs in applications integrated with payment infrastructure.

The first release focuses on **Bachs-powered applications**, particularly those implementing wallet funding, payment collections, and webhook-driven financial operations.

PayProof tests whether applications maintain correct financial state when payment events are:

- Delivered multiple times.
- Processed concurrently.
- Delayed or reordered.
- Interrupted by failures.
- Retried after partial processing.

Unlike general-purpose testing frameworks, PayProof provides predefined payment failure scenarios, financial invariants, controlled concurrency instrumentation, and reproducible execution reports.

PayProof is designed to complement existing testing frameworks such as Vitest rather than replace them.

## Product Vision

Make payment correctness testing accessible to developers without requiring them to design and implement complex concurrency and failure-injection infrastructure themselves.

## Product Promise

**PayProof helps developers discover, explain, and reproduce payment-processing bugs before those bugs affect real money.**

## Primary Differentiator

Controlled concurrency testing combined with financial invariant verification.

PayProof must demonstrate that it can reliably expose a race condition in a vulnerable payment handler, identify the resulting financial inconsistency, and reproduce the failure.

---

# 2. Problem Statement

Payment integrations can appear correct under ordinary testing while containing bugs that emerge under concurrency and failure conditions.

For example, consider a developer implementing a Bachs webhook handler.

The handler:

1. Receives a successful payment notification.
2. Checks whether the payment reference has already been processed.
3. Credits the customer's wallet.
4. Records the completed transaction.

If two identical notifications arrive concurrently, both handlers may check the database before either has recorded the payment.

Both may conclude that the payment is unprocessed and proceed to credit the wallet.

A ₦50,000 deposit could therefore result in ₦100,000 being credited.

A sequential integration test might pass because the first request completes before the second begins.

A concurrent test might expose the issue, but its outcome could depend on timing.

**PayProof addresses this problem by coordinating execution at application-defined checkpoints and checking the resulting financial state.**

## Existing Alternatives

Developers can already use Vitest, Jest, custom mocks, load-testing tools, and payment-provider sandboxes to test payment integrations.

PayProof does not claim to detect bugs that these tools are fundamentally incapable of detecting.

Its value comes from providing reusable payment-specific testing infrastructure, reducing the amount of custom work required to construct difficult scenarios.

---

# 3. Product Goals

## 3.1 Primary Goals

1. Provide an easy-to-install TypeScript SDK for payment correctness testing.
2. Support Bachs payment integrations through a provider-specific adapter.
3. Detect duplicate and missing financial operations.
4. Expose race conditions using controlled execution checkpoints.
5. Verify payment outcomes against financial invariants.
6. Generate reproducible failure reports.
7. Integrate with existing testing frameworks and CI/CD pipelines.
8. Provide a reference wallet application demonstrating vulnerable and corrected implementations.

## 3.2 Secondary Goals

- Support high-concurrency payment testing.
- Simulate network failures and interrupted processing.
- Provide property-based testing capabilities.
- Support additional payment providers.
- Offer an optional CLI and dashboard.

## 3.3 Non-Goals

PayProof will not:

- Process or hold customer funds.
- Replace Bachs' SDK or APIs.
- Test the reliability of Bachs' internal infrastructure.
- Guarantee that an application is free from financial bugs.
- Automatically repair application code.
- Require access to a developer's proprietary source code.
- Perform unauthorized production load testing.
- Bypass webhook signature verification.
- Replace financial reconciliation or accounting systems.

---

# 4. Target Users

## Primary Users

**Fintech backend developers**

Engineers building wallets, payment collections, transfers, and transaction-processing systems.

**Developers integrating Bachs**

Engineers who need to verify that their applications correctly handle payment events, retries, and concurrent operations.

**Payment infrastructure engineers**

Engineers building or maintaining financial workflows where correctness under failure is essential.

## Secondary Users

- QA automation engineers.
- Platform engineers.
- Marketplace developers.
- Engineering teams implementing CI-based payment regression testing.

## Initial Target Workflow

A TypeScript developer with an existing Bachs-powered application installs PayProof, configures a local test environment, instruments critical processing checkpoints, and executes predefined payment correctness scenarios.

---

# 5. Product Experience

PayProof will follow an **SDK-first architecture**.

Developers should be able to integrate PayProof directly into their applications and test suites.

The CLI will be a convenience layer over the same core engine.

## 5.1 Installation

Proposed npm packages:

```bash
npm install -D @payproof/core
npm install -D @payproof/bachs
npm install -D @payproof/sdk
```

Package names are provisional and subject to npm availability.

## 5.2 SDK Usage

```typescript
import { PayProof } from "@payproof/core";
import { bachsAdapter } from "@payproof/bachs";

const payproof = new PayProof({
  provider: bachsAdapter({
    mode: "mock"
  }),
  target: {
    baseUrl: "http://localhost:3000",
    webhookPath: "/webhooks/bachs"
  },
  verification: {
    endpoint: "/__payproof/state"
  }
});

const result = await payproof.run({
  scenario: "concurrent-duplicate-credit",
  concurrency: 2
});

if (!result.passed) {
  throw new Error("Payment correctness test failed");
}
```

This is the proposed public API.

## 5.3 Vitest Integration

PayProof must support execution inside existing test suites.

```typescript
import { describe, it, expect } from "vitest";

describe("Bachs payment correctness", () => {
  it("prevents duplicate wallet credits", async () => {
    const result = await payproof.run({
      scenario: "concurrent-duplicate-credit"
    });

    expect(result.passed).toBe(true);
  });
});
```

Developers should not need to abandon their existing testing framework.

## 5.4 Optional CLI

```bash
npx payproof test \
  --provider bachs \
  --scenario concurrent-duplicate-credit
```

The CLI will be developed after the SDK-based MVP is functional.

---

# 6. System Architecture

PayProof will use a modular architecture.

## 6.1 Core Testing Engine

**Package:** `@payproof/core`

Responsibilities:

- Scenario orchestration.
- Logical payment generation.
- Concurrent event delivery.
- Controlled execution coordination.
- Expected-state modeling.
- Financial invariant evaluation.
- Execution trace recording.
- Failure reporting.
- Replay orchestration.

The core engine must not depend directly on Bachs-specific API implementations.

## 6.2 Bachs Provider Adapter

**Package:** `@payproof/bachs`

Responsibilities:

- Define supported Bachs payment event models.
- Normalize Bachs payment references and statuses.
- Generate Bachs-style local test fixtures.
- Integrate with documented Bachs sandbox APIs.
- Support provider-specific scenario configuration.
- Distinguish simulated events from authentic sandbox events.

### Provider Modes

**Mock mode**

Uses synthetic events modeled on verified Bachs contracts.

This mode supports controlled failure injection without depending on external sandbox behavior.

**Sandbox mode**

Uses actual Bachs sandbox capabilities where supported.

Sandbox operations must follow Bachs' documented authentication, verification, and rate-limit requirements.

### Constraint

PayProof must not fabricate authentic Bachs webhook signatures or represent mock events as genuine Bachs sandbox events.

The exact Bachs API contracts must be verified before implementing sandbox mode.

## 6.3 PayProof Instrumentation SDK

**Package:** `@payproof/sdk`

This package provides test-only instrumentation that allows PayProof to coordinate concurrent application execution.

Its primary responsibility is exposing controlled synchronization checkpoints.

Example:

```typescript
import { checkpoint } from "@payproof/sdk";

async function processPayment(payment: Payment) {
  const existing = await db.transaction.findUnique({
    where: {
      reference: payment.reference
    }
  });

  await checkpoint("after-idempotency-check", {
    key: payment.reference
  });

  if (existing) {
    return;
  }

  await creditWallet(payment);
}
```

### Instrumentation Requirements

- Checkpoints must be disabled by default.
- When disabled, checkpoint calls must return immediately.
- Checkpoints must only activate in explicitly authorized test environments.
- Each checkpoint must support a configurable timeout.
- The controller must release waiting requests if a test is aborted.
- The SDK must avoid introducing production dependencies on the test controller.
- Developers must be able to remove instrumentation without changing business logic.

Instrumentation provides additional testing control but is not required for basic duplicate-event testing.

## 6.4 Race Controller

The Race Controller is a core differentiator.

It coordinates execution across multiple requests using named synchronization checkpoints.

### Responsibilities

1. Register active test sessions.
2. Track logical payment references.
3. Receive checkpoint arrival notifications.
4. Wait until a configured number of participants reach a checkpoint.
5. Release participants according to the test schedule.
6. Record checkpoint arrival and release events.
7. Enforce timeouts and cancellation.
8. Export replayable execution plans.

### Example Scenario

Two requests process the same payment reference.

Both reach `after-idempotency-check`.

The Race Controller waits until both requests have reached that checkpoint before releasing them.

This forces both requests to observe the same pre-credit state in the vulnerable reference implementation.

The resulting financial operations are then verified.

### Technical Limitation

PayProof controls explicitly instrumented synchronization points.

It cannot guarantee arbitrary operating-system, network, or database scheduling.

Reproducibility claims must be limited to the execution behavior PayProof actually controls.

## 6.5 Financial Invariant Engine

The invariant engine compares expected financial outcomes against observed application state.

Initial invariants:

**INV-001: Unique Credit**

Each unique successful payment reference must produce at most one posted wallet credit.

**INV-002: Amount Integrity**

The credited amount must equal the expected amount in the correct currency.

**INV-003: Completion**

Each eligible successful payment must eventually produce the expected credit within a configurable processing deadline.

**INV-004: No Unexpected Credit**

A payment that is not eligible for credit must not create a posted credit.

**INV-005: Aggregate Integrity**

The total observed credits must match the sum of expected eligible payment amounts.

Aggregate checks must not replace individual payment checks.

### Ledger Integrity

For applications using double-entry accounting, PayProof may optionally verify that each journal entry balances.

This is a later-stage feature because not every application exposes a double-entry ledger.

## 6.6 Application Verification Adapter

PayProof must be able to inspect the application's financial outcomes.

The initial approach will use a test-only HTTP endpoint.

Example:

```http
GET /__payproof/state?reference=PAY-001
```

Response:

```json
{
  "reference": "PAY-001",
  "status": "COMPLETED",
  "currency": "NGN",
  "creditedAmountMinor": 5000000,
  "creditCount": 1,
  "ledgerEntries": [
    {
      "id": "entry_001",
      "type": "CREDIT",
      "amountMinor": 5000000
    }
  ]
}
```

Amounts must be represented in integer minor units, not floating-point naira values.

### Requirements

- The endpoint must be test-only.
- It must require appropriate authorization or be bound to an isolated test network.
- It must not expose sensitive production financial records.
- It must support querying individual payment references.
- It must return sufficient information to verify configured invariants.

---

# 7. Core Test Scenarios

## Scenario 1 — Concurrent Duplicate Credit

**Priority:** P0  
**MVP:** Required

### Objective

Reliably expose payment-processing race conditions caused by non-atomic idempotency checks.

### Steps

1. Generate one successful synthetic Bachs-style payment.
2. Create two webhook deliveries using the same payment reference.
3. Send both deliveries concurrently.
4. Pause both handlers after their idempotency checks.
5. Confirm both have reached the checkpoint.
6. Release both handlers.
7. Wait for processing to complete.
8. Query the application's financial state.
9. Verify that only one credit was committed.

### Expected Result

The vulnerable reference implementation fails.

The corrected reference implementation passes.

### Acceptance Criteria

- Both requests reach the configured checkpoint.
- The controller releases both requests.
- The invariant engine detects duplicate credits.
- The failure report identifies the affected payment.
- The same controlled scenario can be executed again.

---

## Scenario 2 — Sequential Duplicate Webhook

**Priority:** P0  
**MVP:** Required

### Objective

Verify idempotency when the same payment notification is delivered repeatedly.

### Steps

1. Deliver a successful payment event.
2. Wait for processing completion.
3. Deliver the same event again.
4. Inspect the financial state.

### Expected Result

The application records exactly one credit.

---

## Scenario 3 — Concurrent Unique Payments

**Priority:** P1

### Objective

Verify that the application correctly processes multiple independent payments concurrently.

### Steps

1. Generate a configurable number of unique payments.
2. Deliver their notifications concurrently.
3. Wait for processing completion.
4. Inspect each payment's financial outcome.
5. Verify individual and aggregate correctness.

### Expected Result

All eligible payments are credited exactly once and with the correct amounts.

---

## Scenario 4 — Interrupted Processing

**Priority:** P1

### Objective

Verify safe recovery when processing is interrupted after a financial operation.

### Requirements

The reference application must provide controlled fault-injection hooks.

### Expected Result

A retry does not produce duplicate financial effects.

---

## Scenario 5 — Out-of-Order Events

**Priority:** P2

### Objective

Verify valid payment state transitions when events arrive in unexpected order.

### Expected Result

The application preserves a valid financial state according to the defined payment lifecycle.

---

# 8. Failure Reporting and Replay

PayProof must generate actionable reports rather than only returning a pass/fail result.

## 8.1 Report Contents

Every failed test must include:

- Scenario name.
- Provider and execution mode.
- Logical payment reference.
- Expected financial state.
- Observed financial state.
- Failed invariant identifiers.
- Event delivery history.
- Checkpoint arrival order.
- Checkpoint release decisions.
- Execution errors and timeouts.
- Reproduction instructions.

## 8.2 Example Report

```text
PAYPROOF — PAYMENT CORRECTNESS REPORT

Provider: Bachs
Mode: Local Mock

Scenario: concurrent-duplicate-credit
Payment Reference: PAY-001

Webhook Deliveries: 2
Checkpoint: after-idempotency-check

Expected Credit: NGN 50,000
Observed Credit: NGN 100,000

FAILED: INV-001 — UNIQUE CREDIT
FAILED: INV-002 — AMOUNT INTEGRITY

Race Condition Detected

Both requests passed the idempotency check
before either completed the financial operation.

Replay:
payproof replay ./reports/race-001.json
```

This is illustrative output.

## 8.3 Replay Requirements

PayProof must record:

- Scenario configuration.
- Random seed.
- Generated event payloads.
- Logical payment identifiers.
- Planned delivery order.
- Checkpoint definitions.
- Synchronization requirements.
- Checkpoint release decisions.

A replay must reset or isolate the application's test state before execution.

For the MVP, replay will reproduce the controlled checkpoint schedule rather than claim complete determinism over external systems.

---

# 9. Reference Application

The repository must include a PostgreSQL-backed TypeScript wallet application.

## 9.1 Technology

- Node.js 24.
- TypeScript.
- Fastify.
- PostgreSQL.
- Prisma.
- Vitest.
- Docker Compose or Testcontainers.

## 9.2 Required Functionality

- Accept synthetic Bachs-style payment notifications.
- Validate test event inputs.
- Maintain customer wallet balances.
- Store payment transaction records.
- Store financial credit records.
- Expose test-only state inspection.
- Support PayProof checkpoints.
- Reset test data between runs.

## 9.3 Vulnerable Implementation

The intentionally vulnerable handler must demonstrate a non-atomic check-then-credit workflow.

The test must show how concurrent requests can cause incorrect financial state.

## 9.4 Corrected Implementation

The corrected handler must use appropriate database transactions and uniqueness constraints.

The financial credit and idempotency record must be committed atomically.

A failed transaction must not leave a committed wallet credit.

## 9.5 Demonstration

The same PayProof scenario must be executed against both implementations.

**Vulnerable handler:** Failed correctness verification.

**Corrected handler:** Passed correctness verification.

---

# 10. Technical Architecture and Repository

## 10.1 Technology Stack

| Component | Technology |
|---|---|
| Language | TypeScript |
| Runtime | Node.js 24 |
| Package manager | pnpm |
| Monorepo | pnpm workspaces |
| SDK packaging | tsup |
| Schema validation | Zod |
| HTTP client | Undici |
| Testing | Vitest |
| Reference API | Fastify |
| Database | PostgreSQL |
| ORM | Prisma |
| Database testing | Testcontainers |
| Property-based testing | fast-check (post-MVP) |
| Optional CLI | Commander.js |
| Optional tracing | OpenTelemetry |

## 10.2 Repository Structure

```text
payproof/
├── apps/
│   ├── reference-wallet/
│   │   ├── src/
│   │   ├── prisma/
│   │   └── tests/
│   │
│   └── cli/
│
├── packages/
│   ├── core/
│   │   ├── src/
│   │   │   ├── orchestrator/
│   │   │   ├── race-controller/
│   │   │   ├── invariants/
│   │   │   ├── scenarios/
│   │   │   ├── replay/
│   │   │   └── reporting/
│   │   └── package.json
│   │
│   ├── sdk/
│   │   ├── src/
│   │   │   ├── checkpoint.ts
│   │   │   └── index.ts
│   │   └── package.json
│   │
│   └── bachs/
│       ├── src/
│       │   ├── adapter.ts
│       │   ├── fixtures/
│       │   └── index.ts
│       └── package.json
│
├── examples/
│   └── vitest-integration/
│
├── reports/
├── docs/
├── pnpm-workspace.yaml
└── README.md
```

---

# 11. Security and Safety Requirements

PayProof must be safe for developers to run against isolated test applications.

### SEC-001: Test Environment Restriction

Controlled fault injection must only operate in explicitly authorized test environments.

### SEC-002: Production Protection

The instrumentation SDK must be disabled by default and must not activate in production without deliberate, explicit configuration.

### SEC-003: Credential Protection

API keys, webhook secrets, and other sensitive values must be redacted from reports.

### SEC-004: Signature Verification

Real Bachs sandbox events must follow the documented signature verification requirements.

Synthetic local events must use a clearly separated mock trust mechanism.

### SEC-005: Controller Timeouts

Waiting checkpoint participants must be released or aborted when a timeout occurs.

### SEC-006: Test Data Isolation

Every scenario must run against isolated or resettable test state.

### SEC-007: No Real Funds

MVP scenarios must not transfer real money or modify production financial records.

---

# 12. Non-Functional Requirements

## Reliability

- Failed test runs must not silently report success.
- Incomplete financial state inspections must be reported as inconclusive or failed, according to configuration.
- Checkpoint waits must have bounded timeouts.
- Tests must support cancellation and cleanup.
- Reference wallet tests must use real database persistence.

## Performance

MVP:

- Support at least two synchronized concurrent webhook deliveries.
- Support configurable duplicate event counts.
- Produce reports without unbounded memory usage for small scenarios.

Post-MVP:

- Support at least 100 concurrent event deliveries in the reference environment.
- Execute 10,000 synthetic event deliveries in a benchmark run.
- Record throughput, latency, and error rates.

These are engineering targets, not measured results.

## Maintainability

- Strict TypeScript typing.
- Modular provider adapters.
- Public interfaces documented.
- Unit tests for all invariant checks.
- Integration tests for checkpoint synchronization.
- Minimal dependencies in the core engine.

---

# 13. MVP Scope

The first MVP will focus on one technically meaningful problem:

**Reproducibly detecting a duplicate-credit race condition in a Bachs-style wallet integration.**

## Required Features

1. TypeScript core SDK.
2. Local Bachs-style provider adapter.
3. Synthetic payment event generation.
4. Concurrent webhook delivery.
5. Test-only checkpoint SDK.
6. Race Controller.
7. Financial state inspection.
8. Unique-credit invariant verification.
9. Failure report generation.
10. PostgreSQL-backed vulnerable and corrected reference wallet.
11. Basic scenario replay.

## Explicitly Excluded From Same-Day MVP

- Dashboard.
- Multiple payment providers.
- Real Bachs sandbox integration.
- High-scale load testing.
- Advanced worker crash injection.
- Automated source-code analysis.
- AI-generated debugging suggestions.
- Full property-based testing.
- Production deployment.

---

# 14. Development Milestones

## Milestone 1 — Reference Wallet

**Estimated effort:** 1–2 hours

Build the reference wallet with PostgreSQL persistence, a webhook handler, and a test-only state inspection endpoint.

Implement both vulnerable and corrected processing modes.

**Completion criterion:** The wallet can process a synthetic payment and expose its committed financial records.

## Milestone 2 — Race Controller

**Estimated effort:** 1–2 hours

Implement named checkpoints, participant tracking, synchronization barriers, timeouts, and release operations.

**Completion criterion:** Two concurrent handlers can reliably be paused and released at the same checkpoint.

## Milestone 3 — PayProof Core

**Estimated effort:** 1–2 hours

Implement event delivery, scenario execution, expected-state modeling, and financial invariant verification.

**Completion criterion:** PayProof can detect a duplicate credit in the vulnerable reference wallet.

## Milestone 4 — Reporting and Replay

**Estimated effort:** 1–2 hours

Implement structured failure reports and basic execution-plan replay.

**Completion criterion:** A failed scenario can be rerun with the same controlled synchronization plan.

## Milestone 5 — npm Packaging

**Estimated effort:** 30–90 minutes

Configure package exports, build output, TypeScript declarations, and package metadata.

Test package installation in a separate project.

**Completion criterion:** Another TypeScript application can install the locally packed SDK and execute a scenario.

## Milestone 6 — Bachs Sandbox Integration

**Post-MVP**

Verify the current Bachs documentation and implement supported sandbox flows.

**Completion criterion:** PayProof can run at least one real sandbox-backed integration test without misrepresenting mock behavior.

---

# 15. MVP Acceptance Criteria

The MVP is complete only when all the following conditions are satisfied.

| ID | Acceptance criterion |
|---|---|
| AC-01 | A developer can install and import the PayProof SDK. |
| AC-02 | PayProof can generate a synthetic Bachs-style successful payment event. |
| AC-03 | PayProof can deliver two concurrent notifications for the same payment. |
| AC-04 | Both requests can be synchronized at a named checkpoint. |
| AC-05 | The vulnerable wallet produces a reproducible duplicate-credit violation. |
| AC-06 | PayProof detects and reports the violation. |
| AC-07 | The corrected wallet passes the same scenario. |
| AC-08 | The failure report includes expected and observed financial state. |
| AC-09 | A recorded test can be replayed after resetting test state. |
| AC-10 | The SDK works inside a Vitest test. |
| AC-11 | The package can be installed from a locally generated npm archive. |
| AC-12 | The README documents setup, execution, architecture, and limitations. |

---

# 16. Engineering Showcase Requirements

Before sharing PayProof with Bachs engineers, the repository should demonstrate more than a working prototype.

## 16.1 Technical Documentation

The repository should include:

- Architecture diagram.
- Explanation of the race controller.
- Financial invariant model.
- Database transaction strategy.
- Event execution and replay design.
- Security boundaries.
- Known limitations.
- Benchmark methodology and measured results.

## 16.2 Demonstration

A short demonstration should show:

1. The vulnerable wallet processing a payment.
2. PayProof synchronizing two concurrent webhook deliveries.
3. The duplicate-credit invariant failing.
4. The generated failure trace.
5. The corrected wallet processing the same scenario.
6. The invariant passing.
7. Integration through a separate TypeScript project.

## 16.3 Bachs Relevance

The final showcase should demonstrate how PayProof fits into a developer's Bachs integration workflow.

Where possible, include an authentic Bachs sandbox scenario alongside the controlled local mock scenario.

The documentation must clearly distinguish these modes.

---

# 17. Success Metrics

## Engineering Success

- Reproducible detection of a known concurrency bug.
- Zero false passes for the deliberately vulnerable reference scenario across repeated controlled runs.
- Corrected reference implementation consistently passes.
- Financial invariants validated against persisted database state.
- Automated test coverage of critical orchestration components.
- Successful installation in an independent TypeScript project.

## Developer Experience

- Minimal configuration for basic duplicate-event testing.
- Small, documented instrumentation API for advanced race testing.
- Clear failure explanations.
- Straightforward Vitest integration.
- No need to modify application business logic beyond optional test checkpoints and inspection adapters.

## Product Validation

After releasing the engineering showcase:

- Obtain feedback from developers who have integrated Bachs or similar payment providers.
- Determine whether the setup effort is acceptable.
- Identify which failure scenarios developers find most valuable.
- Evaluate whether the framework should expand beyond Bachs.

---

# 18. Future Roadmap

## Version 1.2 — Reliability Testing

- Worker crash simulation.
- Network timeout injection.
- Out-of-order event delivery.
- Missing event recovery.
- Expanded replay capabilities.
- Failure sequence minimization.

## Version 1.3 — Advanced Correctness Testing

- Property-based testing.
- Stateful payment workflow verification.
- Refund and payout invariants.
- Custom invariant definitions.
- Double-entry ledger validation.
- CI/CD templates.

## Version 2.0 — Broader Developer Tooling

- Additional payment provider adapters.
- Provider adapter development kit.
- Web-based test visualization.
- Team-level reporting.
- Payment integration readiness assessments.

---

# 19. Open Technical Questions

The following questions should be resolved during implementation or sandbox integration:

1. Which Bachs sandbox payment operations are officially supported?
2. Which webhook event schemas and signature mechanisms are documented?
3. Can Bachs sandbox events be triggered programmatically?
4. How should PayProof model payment status transitions?
5. How should asynchronous application processing completion be detected?
6. What synchronization mechanism best supports instrumented checkpoints across multiple Node.js processes?
7. How should the SDK handle checkpoint controller disconnection?
8. How should test databases be reset between replay attempts?
9. What is the minimum financial state adapter interface developers must implement?
10. Which scenarios provide enough value without application instrumentation?

---

# 20. Final Product Definition

**PayProof is an SDK-first, open-source TypeScript framework for testing the financial correctness of payment-integrated applications.**

Its initial focus is developers integrating Bachs.

PayProof combines:

- Payment-specific test scenarios.
- Controlled concurrency instrumentation.
- Financial invariant verification.
- Reproducible failure reporting.
- Optional CLI tooling.

Its primary technical differentiator is the ability to coordinate concurrent payment-processing operations at explicitly instrumented checkpoints, making difficult race conditions easier to expose and investigate.

### MVP Definition

The first release must demonstrate one complete engineering workflow:

**A vulnerable wallet receives two concurrent notifications for the same Bachs-style payment, credits the wallet incorrectly, and fails PayProof's financial correctness checks. The corrected implementation processes the same scenario and passes.**

### Long-Term Objective

Provide reusable payment correctness testing infrastructure that reduces the effort required for developers to test financial workflows under failure conditions.

### Engineering Objective

Demonstrate strong backend engineering capabilities through concurrency control, distributed-systems reasoning, transaction integrity, test instrumentation, financial invariant modeling, and developer-focused API design.

**PayProof's success will be measured by the correctness and reproducibility of the bugs it can expose, not merely by the volume of requests it can generate.**
