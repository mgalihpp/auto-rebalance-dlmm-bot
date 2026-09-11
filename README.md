# auto-rebalance-dlmm-bot

Bun + TypeScript bot that auto-rebalances a Meteora DLMM liquidity position.
Manual flow (Candidate A): claim fees → exit position → swap via Jupiter →
re-enter a Curve position centered on the active bin. Dry-run mode and dust
skip are grafted in from Candidate B.

To install dependencies:

```bash
bun install
```

## Configure

Copy `.env.example` to `.env` and fill in values (never commit `.env`):

```bash
RPC_URL=https://api.mainnet-beta.solana.com
POOL_ADDRESS=<dlmm-pool-pubkey>
PRIVATE_KEY=<bs58-secret-key>
SLIPPAGE_BPS=50
DRY_RUN=true
COMPOUND_FEES=true
STRATEGY=Curve
JUPITER_API_KEY=<optional>
POLL_INTERVAL_MS=60000
```

The bot is pool-scoped: it manages the funded position in POOL_ADDRESS (one instance per pool). Nothing needs updating after a rebalance. `STRATEGY` selects the DLMM liquidity shape (`Spot`, `Curve`, or
`BidAsk`; default `Curve`). `DRY_RUN=true` prints the preview below and exits without sending
transactions. `COMPOUND_FEES=false` withdraws fees to the wallet on exit but
excludes them from the redeposit targets (default `true` reinvests them). The new Curve range always follows the original position width,
recentered on the active bin.

## Run

```bash
bun run index.ts
```

Dry-run preview example:

```text
=== DLMM auto-rebalance preview ===
Pool:            7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU
Position:        3v8o7d1CW87d97TXJSDpbD5jBkheTqA83TZRuJosgUt9
Active bin:      4521
Current range:   4487 - 4555
Range: original 4487-4555 (width 68) -> new 4487-4555
Current:         X=1000000 Y=2000000
Rebalanced:      X=1000000 Y=2000000 (Curve 4487 - 4555)
Swaps required:  none
Fees claimed:    X=10000 Y=20000 (lifetime)
Slippage:        50 bps
Dry run — no transactions sent.
```

The bot runs continuously, re-checking every `POLL_INTERVAL_MS` (default 60000).
It rebalances only when the active bin leaves the position range; otherwise it
logs `Position in range ... no rebalance needed.` and sleeps until the next
check. A single-sided position previews a
Jupiter leg instead, e.g. `Swaps required:  X -> Y amount=500000 minOut=497500 (Jupiter)`.

## Verify

```bash
bun run check:write
bun run check
bun run typecheck
bun test
```

Notes:

- `@solana/web3.js` stays v1; Jupiter is plain REST (`GET /swap/v2/order` +
  `POST /swap/v2/execute`) with no SDK dependency.
- On-chain amounts use `bn.js`; `decimal.js` is display/bin-price math only.
- Tests are offline (`bun test` never hits RPC).
