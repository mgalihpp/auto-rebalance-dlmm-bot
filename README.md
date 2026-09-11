# rebalance-dlmm-bot

Bot penjaga posisi DLMM Meteora. Tiap interval dia cek active bin: kalau harga keluar range, dia rebalance otomatis **in place** meniru tombol Rebalance di web Meteora — posisi yang sama dipertahankan (tidak close, tidak bikin baru), lebar range ikut posisi lama dan terpusat di active bin. Pokok di-split 50/50, sisi berlebih di-swap via Jupiter, fee diklaim ke wallet tanpa ikut deposit. Log status: `InRange` / `NearEdge` / `OutOfRange` / `NoPosition`.

## Jalan

```bash
bun install
cp .env.example .env
bun run index.ts
```

| Var | Isi |
|---|---|
| `RPC_URL`, `POOL_ADDRESS` | wajib |
| `POSITION_PUBKEY`, `WALLET_PRIVATE_KEY` | wajib buat live; kosong = mode pantau |
| `DRY_RUN` | default `true` (cuma log rencana, tanpa tx) |
| `STRATEGY` | `Spot` / `Curve` / `BidAsk`, default `Spot` |
| `CHECK_INTERVAL_MS`, `EDGE_BUFFER_BINS` | default `60000`, `2` |
| `SLIPPAGE_BPS`, `SWAP_SLIPPAGE_BPS` | default `100`, kosong = ikut `SLIPPAGE_BPS` |
| `POSITION_WIDTH_BINS` | kosong = ikut lebar posisi lama |
| `COMPOUND_FEES` | `false` = fee tidak ikut swap/deposit (ala web), default `false` |
| `SOL_RESERVE_SOL` | gas native yang tidak boleh disentuh, default `0.02` |

Jupiter V2 jalan keyless dengan limit rendah; kalau punya key, `export JUPITER_API_KEY=...` di shell saja — jangan masuk file atau git.

## Live

Tarik 100% tanpa close → kaki SOL di-wrap ke wSOL (cadangan gas tetap native, abort kalau gas kurang) → swap Jupiter V2 (`/order`, sign lokal, `/execute`) → deposit in place dengan haircut penuh dari selisih saldo wallet. Sizing dan deposit hanya baca token account, tidak pernah saldo native; topUp melebihi saldo ATA = abort.

## Recovery

Kalau withdraw terkirim tapi swap gagal, dana aman di wallet dan posisi kosong tapi hidup. Jangan withdraw ulang — panggil `completeRebalanceFromWallet(ctx, config, snapshot, plan, walletBefore)` dari `src/rebalance.ts`. `walletBefore` = snapshot sebelum withdraw, atau `"0"` bila tidak tercatat.
