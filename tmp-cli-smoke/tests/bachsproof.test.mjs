export const tests = [
  {
    name: "black-box duplicate delivery",
    scenario: "sequential-duplicate-webhook",
    reference: process.env.BACHSPROOF_REFERENCE ?? `BACHSPROOF-INIT-${Date.now()}`,
    amountMinor: 5_000_000,
    currency: "NGN"
  }
];

// Optional committed-state verifier. Keep this in the test project, not in
// production. Add `verify` to bachsproof.config.mjs when it is implemented.
//
// export async function verify(reference) {
//   const credits = await testDatabase.walletCredit.findMany({ where: { reference } });
//   return {
//     reference,
//     creditCount: credits.length,
//     creditedAmountMinor: credits.reduce((sum, credit) => sum + Number(credit.amountMinor), 0),
//     currency: credits[0]?.currency ?? "NGN"
//   };
// }
