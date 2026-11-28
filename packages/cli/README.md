# `@bachsproof/cli`

The CLI is the supported BachsProof v2 entry point.

```bash
pnpm add -D @bachsproof/cli
pnpm exec bachsproof init
pnpm exec bachsproof test
```

`init` creates one `bachsproof.config.mjs` file. The file contains the complete
webhook URL, test signing secret, amount, currency, `createPayment()`, and
`verify()` callbacks. The CLI configures the Bachs adapter, webhook signing,
the eleven scenarios, ordinary concurrent delivery, and mandatory financial
verification automatically.

The same config object works in Vitest, Jest, or a custom script:

```js
import { loadConfig, runConfig, summarizeRuns } from "@bachsproof/cli";

const config = await loadConfig("bachsproof.config.mjs");
const results = await runConfig(config);
console.log(summarizeRuns(results));
```

Financial verification is required. Configure a test-only application and
database; BachsProof never calls Bachs or moves real money.
