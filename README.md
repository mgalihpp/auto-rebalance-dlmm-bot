# auto-rebalance-dlmm-bot

Auto-rebalances a [Meteora DLMM](https://docs.meteora.ag/core-products/dlmm/dlmm) liquidity position when price moves out of range. Uses the same zap-sdk engine as the Meteora UI: simulate the new range, swap the balancing leg, zap back into the existing position.

Built with Bun, TypeScript, Effect, and the Meteora DLMM SDK.

## Quick start

```bash
bun install
```

Copy `.env.example` to `.env` and fill in:

```bash
RPC_URL=https://api.mainnet-beta.solana.com
POOL_ADDRESS=<dlmm-pool-pubkey>
PRIVATE_KEY=<bs58-secret-key>
```

Run:

```bash
bun run index.ts
```

## How it works

The bot runs in a loop, checking every `POLL_INTERVAL_MS` (default 60s). If the active bin leaves the position range, it:

1. Estimates the balancing swap for a new range of the same width, centered on the active bin
2. Builds a remove, swap, zap-in sequence for the existing position
3. Sends the transactions (skipped in dry-run)

Claimed fees are part of the withdrawn proceeds, so they get redeposited automatically.

If the active bin is still inside the range, it logs "no rebalance needed" and sleeps until next check.

## Configuration

| Variable | Default | Description |
|---|---|---|
| `RPC_URL` | (required) | Solana RPC endpoint |
| `POOL_ADDRESS` | (required) | DLMM pool address |
| `PRIVATE_KEY` | (required) | Wallet secret key (bs58) |
| `DRY_RUN` | `true` | Preview only, no transactions |
| `SLIPPAGE_BPS` | `50` | Slippage tolerance in basis points |
| `STRATEGY` | `Curve` | Liquidity shape: `Spot`, `Curve`, or `BidAsk` |
| `POLL_INTERVAL_MS` | `60000` | Recheck interval (min 5000) |

## Output

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

## Tech stack

- `@meteora-ag/dlmm` for position state
- `@meteora-ag/zap-sdk` for the rebalance itself (same engine as the Meteora UI, Jupiter routing included)
- `@solana/web3.js` v1 (not v2)
- `bn.js` for on-chain amounts
- `effect` for structured error handling
