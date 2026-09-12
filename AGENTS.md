# Auto Rebalance DLMM Bot

Bun + TypeScript + Effect bot that keeps one Meteora DLMM position in range via `@meteora-ag/zap-sdk` (remove → swap → zap-in).

You can think of it as a tiny poll loop: load position, check if the active bin left the range, and if so re-center the same width on the active bin and zap back in.

## Who you work for

I am Galih. You are my personal coding agent. Your job is to implement exactly what I ask — nothing more — keep this bot safe with real funds, and leave it simpler than you found it.

Think of these instructions less as hard rules, more as good defaults. My explicit request always overrides anything here. If a rule here fights the task in front of you, say so loudly and get my sign-off before breaking it.

## A note from Galih

I like ambitious ideas, simple systems, and software that feels obvious. Do not preserve complexity just because it already exists. Do not introduce machinery because it looks architecturally impressive. Understand the real constraint, then fight for the smallest model that makes the correct behavior unsurprising.

Channel both "measure twice, cut once" and "yagni". Fight scope creep. Honor my intent in a minimal and realistic fashion.

Of note: most work here touches real money on mainnet. Default to preview-only. Never send a transaction unless I explicitly asked for a live run.

## A small glossary

We need to be on the same page. When communicating, use this language:

- **you** means the agent reading this file and changing the bot.
- **I, Galih, owner** means the person you work for. Only I can authorize live transactions.
- **bot** means this poll loop (`index.ts` → `src/index.ts`).
- **pool** means the DLMM pool in `POOL_ADDRESS`. One bot instance manages one pool.
- **position** means my funded DLMM position in that pool. The bot expects exactly one.
- **zap** means the remove → swap → zap-in sequence built by `@meteora-ag/zap-sdk` (same engine as the Meteora UI).
- **dry run** means `DRY_RUN=true`: print the preview, send nothing.
- **live** means real transactions: `DRY_RUN=false` in the loop, or `scripts/test-rebalance.ts --live`.

## The three ways to hurt yourself

Real funds. These are the only three ways to cause real damage here:

1. **Sending real transactions.** `bun run scripts/test-rebalance.ts --live` ignores `DRY_RUN` and the range gate and sends REAL transactions (5s abort window). Without `--live` it exits(2) without touching RPC. `DRY_RUN=false` in the poll loop also sends. Never run `--live` or set `DRY_RUN=false` unless I explicitly asked for it, in this exact session, for this exact command.
2. **Leaking the key.** Never commit `.env` (gitignored) or log `PRIVATE_KEY` (bs58, 64 bytes). Never print `secretKey`, keypairs, or full `.env` contents. Default to `DRY_RUN=true`.
3. **Breaking money math or the SDK pin.** `@solana/web3.js` must stay on v1 — DLMM SDK and the zap flow depend on the v1 API. Amounts are `bn.js`, price/bin display is `decimal.js`. Never floats for amounts. `DUST_THRESHOLD = 1000` in `plan.ts` gates dust swaps — don't remove it to "simplify".

## Close the loop

The most common defect here is a change that previews correctly and fails on send. Before calling rebalance work done, walk this list and say which entries applied:

- **Gate.** `shouldRebalance` has no drift threshold — any active bin outside `[lower, upper]` triggers. Don't add one without asking.
- **Width.** Rebalance reuses the original half-width re-centered on the active bin: `originalHalfRange = max(1, floor((upper - lower) / 2))`. New range is `active ± halfWidth`.
- **ATAs.** `executeZapRebalance` creates missing user ATAs first (SDK `getOrCreateATAInstruction`, Token-2022 aware). Otherwise simulation fails with `AccountNotInitialized (3012)`. Don't reorder this after the zap build.
- **Send pipeline.** `sendManualTransaction` is simulate at 1.4M CU → limit `ceil(used * 1.1)` capped at 1.4M → `getPriorityFeeEstimate` → `sendRawTransaction(skipPreflight: true)` with poll/resend until blockhash expiry. Don't "fix" it to a static limit or preflight-on.
- **Fees.** `getPriorityFeeEstimate` is Helius-only; other RPCs warn and fall back to 0 priority fee. Use a Helius `RPC_URL` for the poll loop — `api.mainnet-beta.solana.com` is rate-limited for this.
- **Single position.** `resolvePosition` auto-picks the single funded position and errors on zero or 2+ funded positions. Don't silently pick the first of many.

## Running and verifying

- `bun install` installs. Runtime is Bun only (`bun run index.ts` / `bun start`). Don't use node/npm/ts-node.
- `bun test` runs all tests. `bun test test/<file>` runs one file.
- `bun run check` (biome lint+format check), `bun run check:write` (auto-fix), `bun run typecheck` (`tsc --noEmit`).
- After edits: `bun run check:write`, then `bun run typecheck`, then `bun test`. Smallest proof that the change works — targeted file first, full `bun test` before finishing.
- Tests are offline by design — no RPC/network in `bun test`. Never add a test that dials RPC. `docs/*.txt` are vendored Meteora/Jupiter SDK references; consult them before changing SDK calls instead of guessing from memory.

## Config: trust code over example

`src/config.ts` is the source of truth. `.env.example` is stale on one field:

- `STRATEGY` default is `Curve` per `src/config.ts`, not `Spot`. Accepts `Spot|Curve|BidAsk` case-insensitive, plus `bid-ask`/`bid_ask`.
- `DRY_RUN` defaults `true`, `SLIPPAGE_BPS` 50 (0–10000), `POLL_INTERVAL_MS` 60000 (5000–3600000). `RPC_URL` must be http(s), `POOL_ADDRESS` a valid pubkey, `PRIVATE_KEY` valid bs58 decoding to 64 bytes.
- `loadDotenv()` runs at startup in both `src/index.ts` and `scripts/test-rebalance.ts`; `loadConfig(process.env)` validates via Effect (`ConfigError`).

## How it works

Each poll iteration runs one `Effect.gen`: `loadPositionState` → `shouldRebalance` → `planZapRebalance` (off-chain estimate + preview log) → `executeZapRebalance` (unless dry run). Errors are `Data.TaggedError` (`ConfigError`/`PlanError`/`DlmmError`/`ZapError`/`SendError`) surfaced via `Effect.runPromise`. `SIGINT`/`SIGTERM` shut the loop down gracefully; the loop sleeps `POLL_INTERVAL_MS` between iterations and wakes early on shutdown.

## Where code lives

- `index.ts` — entrypoint, re-exports `src/`.
- `src/index.ts` — poll loop, preview logging, shutdown handling.
- `src/config.ts` — env parsing/validation (Effect). Edit here for new env vars.
- `src/rebalance/dlmm.ts` — pool/position loading, `resolvePosition`.
- `src/rebalance/plan.ts` — range math (`shouldRebalance`, `originalHalfRange`), offline swap preview.
- `src/rebalance/zap.ts` — live zap estimate (`planZapRebalance`) + execute.
- `src/rebalance/send.ts` — transaction send pipeline.
- `scripts/test-rebalance.ts` — manual one-shot live trigger (`--live` only). No drift gate, no dry-run, no loop.
- `test/` — offline unit tests (`bun:test`). `docs/meteora-llms-full.txt`, `docs/jupiter-llms-*.txt` — vendored SDK references, read-only.

## Taste

- Effect-heavy: `Effect.gen` pipelines with tagged errors, surfaced at the edge with `Effect.runPromise`. Don't throw raw exceptions across module boundaries.
- Inferred types over annotations where the codebase already does it. `any` is the enemy.
- Biome: tabs + double quotes, organize-imports on. Run `bun run check:write` after edits.
- Comments describe how a thing is used, mostly on functions — not every line. Most code changes need no docs change; agents can read the code.
- Do not commit implementation plans, research notes, or agent scratch files. Never make a PR unless I explicitly ask.
