# rebalance-dlmm-bot

To install dependencies:

```bash
bun install
```

To run:

```bash
bun run index.ts
```

This project was created using `bun init` in bun v1.4.1. [Bun](https://bun.com) is a fast all-in-one JavaScript runtime.

## Auto Rebalance Bot (Meteora DLMM, DOGE/SOL)

Polls a Meteora DLMM pool and holds or rebalances a position. Main trigger is
**OUT OF RANGE**: rebalance when the active bin leaves `[lowerBinId, upperBinId]`.

### Install

```bash
bun install
```

### Env

```bash
cp .env.example .env
```

Fill at minimum:

- `RPC_URL` — Solana RPC endpoint
- `POOL_ADDRESS` — DOGE/SOL DLMM pool address (see https://app.meteora.ag/dlmm)
- `POSITION_PUBKEY` — your position address (optional; if empty the bot only
  monitors the pool and always `Hold`s with `NoPosition`)

Defaults: `CHECK_INTERVAL_MS=60000`, `SLIPPAGE_BPS=100`,
`DRY_RUN=true`, `EDGE_BUFFER_BINS=2`.

Position width follows the existing position: native `rebalance_liquidity`
shifts the range with the same width, it does not add bins.

### Run

```bash
bun run index.ts
```

One status line per poll, e.g.:

```text
[BOOT] pool=... position=... edgeBuffer=2 interval=60000ms dryRun=true
[2026-09-11T07:00:00.000Z] status=InRange active=500 range=[480,520] decision=Hold reason="active bin 500 inside [480, 520]" dryRun=true
```

### DRY_RUN

Default `DRY_RUN=true`: the bot only logs what it *would* do, never sends
transactions. Set `DRY_RUN=false` (with `WALLET_PRIVATE_KEY` holding your key
in base58 or JSON-array form) only when you want the live native rebalance
(`simulateRebalancePositionWithBalancedStrategy` + `rebalancePosition`,
same-width shift, no close/reopen).
