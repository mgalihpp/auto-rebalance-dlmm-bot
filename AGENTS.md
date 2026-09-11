# AGENTS.md — auto-rebalance-dlmm-bot

Bun + TypeScript bot that auto-rebalances a Meteora DLMM liquidity position.
Entry: `index.ts` (repo root). Tests: `test/*.test.ts` via `bun:test`.

## Commands (bun only — no npm/node)

```bash
bun install          # install
bun run index.ts     # run (or: bun start)
bun test             # all tests
bun test test/<file> # single file
bun run check        # biome lint+format check (must pass)
bun run check:write  # auto-fix biome issues (tabs, import order)
bun run typecheck    # tsc --noEmit (must pass)
```

Verify in this order after changes: `check:write` → `check` → `typecheck` → `test`.
Biome enforces **tabs + double quotes**; `bun init` scaffolding used spaces, so always run `check:write` after touching scaffolded files.

## Hard constraints

- **`@solana/web3.js` must stay v1** (`"1"` in package.json). The DLMM SDK and all Jupiter doc examples use the v1 API; v2 breaks them. Never upgrade to v2.
- **`effect` is v4 RC** (`^4.0.0-rc.115`), not v3. Effect v3 docs/blog snippets may not apply — verify against the installed package's types.
- **Jupiter has no SDK dependency on purpose.** Swap API V2 is plain REST (`GET /swap/v2/order` + `POST /swap/v2/execute`, or `/build` for custom tx assembly) via built-in `fetch`. Do not add a Jupiter SDK package.
- **Tests must stay offline.** `test/deps.test.ts` constructs a `Connection` but never hits RPC. No network calls in tests — RPC/keypair-network tests will be flaky and slow.

## Local docs (read before guessing SDK usage)

Vendored in `docs/` — prefer these over memory, Meteora/Jupiter APIs drift fast:

- `docs/meteora-llms-full.txt` — DLMM SDK (`DLMM.create`, positions, rebalance, fees)
- `docs/jupiter-llms-full.txt` + `docs/jupiter-llms.txt` — Swap API V2 flows
- Gotcha: `https://developers.jup.ag/docs/ai/llms-txt` returns HTML, not text. The raw files live at `developers.jup.ag/docs/llms.txt` and `/docs/llms-full.txt`.

## Conventions & gotchas

- `tsconfig`: `verbatimModuleSyntax` (type-only imports need `import type`), `noUncheckedIndexedAccess` (indexed access is `T | undefined` — narrow it), `strict` on.
- Money math: `bn.js` for on-chain amounts, `decimal.js` for price/bin math. Never use floats for amounts.
- Secrets via `.env` + `dotenv` (`PRIVATE_KEY` bs58, RPC URL, pool address). `.env*` is gitignored — never commit keys or log secret material.
- `bun test` prints `bigint: Failed to load bindings, pure JS will be used` — harmless native-binding fallback, not a failure.
