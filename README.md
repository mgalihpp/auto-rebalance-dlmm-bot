<p align="center">
  <img src="docs/a6d220c1-55bc-4651-85c0-30f6fc51426e.png" alt="auto-rebalance-dlmm-bot">
</p>

<p align="center">
  <strong>Keep your position in range.</strong>
</p>

<p align="center">
  <a href="https://bun.sh"><img src="https://img.shields.io/badge/runtime-Bun-f472b6?style=flat&colorA=222222" alt="Bun"></a>
  <a href="https://www.typescriptlang.org"><img src="https://img.shields.io/badge/TypeScript-3178C6?style=flat&colorA=222222&logo=typescript&logoColor=white" alt="TypeScript"></a>
  <a href="https://effect.website"><img src="https://img.shields.io/badge/Effect-000000?style=flat&colorA=222222" alt="Effect"></a>
</p>

# Overview

Keeps a [Meteora DLMM](https://docs.meteora.ag/get-started) liquidity position in range. When price moves out of your position, the bot removes liquidity, swaps the balancing leg, and zaps back in. It uses the same `@meteora-ag/zap-sdk` code as the Meteora UI.

## How it works

1. On every poll interval, the bot loads your position and checks the active bin against your position range.
2. If the active bin is still inside the range, it logs and sleeps until the next check.
3. If price moved out of range, it:
   - Reuses your current range width, re-centered on the active bin.
   - Asks `zap-sdk` to estimate the balancing swap.
   - Builds a remove → swap → zap-in sequence for the existing position.
   - Sends the transaction unless `DRY_RUN=true`.

Claimed fees come out with the withdrawal. By default they stay in your wallet. Set `COMPOUND_FEES=true` to put them back in on rebalance.

## Prerequisites

- [Bun](https://bun.sh) installed
- A Solana wallet with an existing funded DLMM position
- A [Helius](https://helius.dev) RPC endpoint. Recommended, see below.

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

> Use a Helius RPC for `RPC_URL`. `getPriorityFeeEstimate` is Helius-only.
> Other RPCs fall back to 0 priority fee, and the public
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
| `RPC_URL` | Yes | none | Solana RPC endpoint (Helius recommended) |
| `POOL_ADDRESS` | Yes | none | DLMM pool address the bot manages |
| `PRIVATE_KEY` | Yes | none | Wallet secret key (bs58, 64 bytes) |
| `DRY_RUN` | No | `true` | If `true`, preview only, it sends nothing |
| `COMPOUND_FEES` | No | `false` | If `true`, redeposit claimed fees back into the position after a rebalance; if `false`, claimed fees stay in the wallet |
| `SLIPPAGE_BPS` | No | `50` | Slippage tolerance in basis points (0–10000) |
| `STRATEGY` | No | `Curve` | Liquidity shape: `Spot`, `Curve`, or `BidAsk` |
| `JUPITER_API_KEY` | No | none | Optional Jupiter API key for zap routing |
| `POLL_INTERVAL_MS` | No | `60000` | Recheck interval in ms (5000–3600000) |
| `TELEGRAM_BOT_TOKEN` | No | none | Bot token for Telegram alerts and commands. Set both Telegram vars to enable, leave both empty to disable. |
| `TELEGRAM_CHAT_ID` | No | none | Private chat id the bot talks to. It ignores every other chat. |
| `TELEGRAM_POLL_INTERVAL_MS` | No | `3000` | Telegram command poll interval in ms (1000–60000), separate from `POLL_INTERVAL_MS` |

Stop the bot with `Ctrl+C`. It shuts down cleanly on `SIGINT` and `SIGTERM`.

## Example output

Dry run when a rebalance is needed.

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

In range, nothing to do.

```text
Position in range (active 4521 within 4487-4555) — no rebalance needed.
```

Live run.

```text
Rebalanced via zap: <transaction-signature>
```

## Telegram

Set `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` to get private chat alerts for startup, shutdown, rebalance previews, completed rebalances with Solscan link, and iteration failures. Healthy polls stay silent.

The bot replies within one `TELEGRAM_POLL_INTERVAL_MS`.

- `/status`. Read-only position snapshot.
- `/help`. List commands.
- `/rebalance`. Preview only, never sends.
- `/rebalance confirm`. Queue a live run. It runs serialized with the main loop, and still only previews while `DRY_RUN=true`.

```text
index.ts                  # entrypoint, re-exports src/
src/
  index.ts                # poll loop, preview logging, shutdown handling
  config.ts               # env parsing / validation (Effect)
  utils.ts                # shared formatting + time helpers (formatBn, nowStamp)
  telegram/
    notify.ts             # Telegram event formatting + sending (HTML, no new deps)
    commands.ts           # chat command parsing + live-confirm handoff
  rebalance/
    types.ts              # domain types (StrategyKind, PositionSnapshot) + SDK mapping
    dlmm.ts               # position + pool state loading
    plan.ts               # range math (`shouldRebalance`, `originalHalfRange`)
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

- `@solana/web3.js` must stay on v1. The DLMM SDK and Jupiter examples rely on the v1 API.
- Money math uses `bn.js` for on-chain amounts and `decimal.js` for price/bin math. Don't use floats for amounts.
- Tests are offline by design. No RPC or network calls in `bun test`.
- Biome enforces tabs and double quotes. Run `bun run check:write` after edits.

You can also trigger a one-off rebalance manually. It sends real transactions with no dry run.

```bash
bun run scripts/test-rebalance.ts --live
```

Without `--live` it exits immediately without touching RPC. It waits 5 seconds before sending so you can abort with `Ctrl+C`.

## Safety

- Start with `DRY_RUN=true` and a dedicated wallet with limited funds. I would not point this at a wallet you cannot afford to lose.
- Never commit `.env` or log your `PRIVATE_KEY`. `.env*` is gitignored.
- The zap flow removes liquidity, swaps, then deposits again. Understand its slippage and IL implications before you run with `DRY_RUN=false`.

## Resources

- `docs/meteora-llms-full.txt`. DLMM SDK reference, covers `DLMM.create`, positions, rebalance, fees.
- `docs/jupiter-llms-full.txt`, `docs/jupiter-llms.txt`. Jupiter Swap API V2 flows.
- [Meteora DLMM docs](https://docs.meteora.ag/get-started)
