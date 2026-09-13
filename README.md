# Overview

Keeps a [Meteora DLMM](https://docs.meteora.ag/get-started) liquidity position in range. When price moves out of your position, the bot removes liquidity, swaps the balancing leg, and zaps back in — using the same `@meteora-ag/zap-sdk` engine as the Meteora UI.

Built with Bun, TypeScript, and Effect.

## How it works

1. On every poll interval, the bot loads your position and checks the active bin against your position range.
2. If the active bin is still inside the range, it logs and sleeps until the next check.
3. If price moved out of range, it:
   - Reuses your current range width, re-centered on the active bin,
   - Asks `zap-sdk` to estimate the balancing swap,
   - Builds a remove → swap → zap-in sequence for the existing position,
   - Sends the transaction (unless `DRY_RUN=true`).

Claimed fees are part of the withdrawn proceeds, so they get redeposited on rebalance.

## Prerequisites

- [Bun](https://bun.sh) installed
- A Solana wallet with an existing funded DLMM position
- A [Helius](https://helius.dev) RPC endpoint (recommended, see below)

## Getting started

```bash
bun install
cp .env.example .env
```

Fill in `.env`:

```env
RPC_URL=https://mainnet.helius-rpc.com/?api-key=<your-api-key>
POOL_ADDRESS=<dlmm-pool-pubkey>
PRIVATE_KEY=<bs58-secret-key>
```

> Use a Helius RPC for `RPC_URL`. `getPriorityFeeEstimate` is Helius-only
> (other RPCs fall back to 0 priority fee), and the public
> `api.mainnet-beta.solana.com` endpoint is rate-limited for the poll loop.
> Get a free API key at [helius.dev](https://helius.dev).

Then run the bot:

```bash
bun run index.ts
# or
bun start
```

The bot starts in `DRY_RUN=true` by default, so it only prints what it *would* do. Set `DRY_RUN=false` when you are ready to send real transactions.

## Configuration

| Variable | Required | Default | Description |
| --- | :---: | --- | --- |
| `RPC_URL` | Yes | — | Solana RPC endpoint (Helius recommended) |
| `POOL_ADDRESS` | Yes | — | DLMM pool address the bot manages |
| `PRIVATE_KEY` | Yes | — | Wallet secret key (bs58, 64 bytes) |
| `DRY_RUN` | No | `true` | If `true`, preview only — no transactions are sent |
| `SLIPPAGE_BPS` | No | `50` | Slippage tolerance in basis points (0–10000) |
| `STRATEGY` | No | `Curve` | Liquidity shape: `Spot`, `Curve`, or `BidAsk` |
| `JUPITER_API_KEY` | No | — | Optional Jupiter API key for zap routing |
| `POLL_INTERVAL_MS` | No | `60000` | Recheck interval in ms (5000–3600000) |

Stop the bot with `Ctrl+C` (`SIGINT`/`SIGTERM` are handled gracefully).

## Example output

Dry run, rebalance needed:

```text
=== DLMM auto-rebalance preview (zap) ===
Pool:            7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU
Position:        3v8o7d1CW87d97TXJSDpbD5jBkheTqA83TZRuJosgUt9
Active bin:      4521
Current range:   4487 - 4555
New range:       active 4521 delta -34..+34
Rebalanced:      X=1000000 Y=2000000
Swaps required:  X -> Y amount=500000 expectedOut=490000
Slippage:        50 bps
Dry run — no transactions sent.
```

In range, nothing to do:

```text
Position in range (active 4521 within 4487-4555) — no rebalance needed.
```

Live run:

```text
Rebalanced via zap: <transaction-signature>
```

## Project structure

```text
index.ts                  # entrypoint, re-exports src/
src/
  index.ts                # poll loop, preview logging, shutdown handling
  config.ts               # env parsing / validation (Effect)
  utils.ts                # shared formatting + time helpers (formatBn, nowStamp)
  rebalance/
    types.ts              # domain types (StrategyKind, PositionSnapshot, SwapLeg) + SDK mapping
    dlmm.ts               # position + pool state loading
    plan.ts               # range math, shouldRebalance, swap preview
    zap.ts                # zap-sdk estimate + execute
    send.ts               # transaction sending
scripts/
  test-rebalance.ts       # manual live rebalance trigger (--live)
test/                     # offline unit tests (bun:test)
docs/                     # vendored Meteora / Jupiter references
```

## Development

```bash
bun test                 # run all tests
bun test test/<file>     # run a single test file
bun run check            # biome lint + format check
bun run check:write      # auto-fix biome issues
bun run typecheck        # tsc --noEmit
```

Notes:

- `@solana/web3.js` must stay on v1 — the DLMM SDK and Jupiter examples rely on the v1 API.
- Money math uses `bn.js` for on-chain amounts and `decimal.js` for price/bin math. Don't use floats for amounts.
- Tests are offline by design — no RPC or network calls in `bun test`.
- Biome enforces tabs + double quotes. Run `bun run check:write` after touching scaffolded files.

There is also a manual trigger for one-off rebalances (sends **real** transactions, no dry-run):

```bash
bun run scripts/test-rebalance.ts --live
```

Without `--live` it exits immediately without touching RPC. It waits 5 seconds before sending so you can abort with `Ctrl+C`.

## Safety

- Start with `DRY_RUN=true` and a dedicated wallet with limited funds.
- Never commit `.env` or log your `PRIVATE_KEY`. `.env*` is gitignored.
- Understand the zap flow (remove → swap → deposit) and its slippage/IL implications before running with `DRY_RUN=false`.

## Resources

- `docs/meteora-llms-full.txt` — DLMM SDK reference (`DLMM.create`, positions, rebalance, fees)
- `docs/jupiter-llms-full.txt`, `docs/jupiter-llms.txt` — Jupiter Swap API V2 flows
- [Meteora DLMM docs](https://docs.meteora.ag/get-started)
