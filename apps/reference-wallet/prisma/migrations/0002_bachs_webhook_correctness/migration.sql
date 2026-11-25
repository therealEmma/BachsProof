-- Bachs-native event identity and exact decimal storage metadata.
ALTER TABLE "Payment"
  ADD COLUMN "amountScale" INTEGER NOT NULL DEFAULT 2,
  ADD COLUMN "providerPaymentId" TEXT,
  ADD COLUMN "checkoutId" TEXT,
  ADD COLUMN "lastEventCreatedAt" TIMESTAMP(3),
  ADD COLUMN "lastEventId" TEXT;

CREATE UNIQUE INDEX "Payment_providerPaymentId_key" ON "Payment"("providerPaymentId");
CREATE INDEX "Payment_checkoutId_idx" ON "Payment"("checkoutId");

ALTER TABLE "WalletCredit"
  ADD COLUMN "amountScale" INTEGER NOT NULL DEFAULT 2,
  ADD COLUMN "eventId" TEXT NOT NULL DEFAULT '';

-- Existing rows predate event identity. Their own ledger id is a safe local
-- audit value; it is not presented as a Bachs event id.
UPDATE "WalletCredit" SET "eventId" = "id" WHERE "eventId" = '';
ALTER TABLE "WalletCredit" ALTER COLUMN "eventId" DROP DEFAULT;

CREATE TABLE "WebhookEvent" (
  "id" TEXT NOT NULL,
  "eventId" TEXT NOT NULL,
  "eventType" TEXT NOT NULL,
  "eventCreatedAt" TIMESTAMP(3) NOT NULL,
  "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "reference" TEXT,
  "providerPaymentId" TEXT,
  "status" TEXT NOT NULL,
  "paymentId" TEXT,
  CONSTRAINT "WebhookEvent_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "WebhookEvent_eventId_key" ON "WebhookEvent"("eventId");
CREATE INDEX "WebhookEvent_reference_idx" ON "WebhookEvent"("reference");
CREATE INDEX "WebhookEvent_providerPaymentId_idx" ON "WebhookEvent"("providerPaymentId");

ALTER TABLE "WebhookEvent"
  ADD CONSTRAINT "WebhookEvent_paymentId_fkey"
  FOREIGN KEY ("paymentId") REFERENCES "Payment"("id") ON DELETE SET NULL ON UPDATE CASCADE;
