# rebalance-dlmm-bot

Bot sederhana untuk menjaga posisi liquidity di **Meteora DLMM** (contoh: pool DOGE/SOL) tetap aktif menghasilkan fee.

Kalau harga keluar dari range posisi kamu, bot akan otomatis **rebalance in-place** — mirip tombol Rebalance di web Meteora. Posisi yang sama dipakai lagi (tidak di-close, tidak bikin posisi baru), range baru dipusatkan di active bin dengan lebar mengikuti posisi lama.

## Kenapa bot ini ada?

Di DLMM, fee cuma didapat kalau harga (active bin) masih di dalam range posisi. Kalau harga jalan terlalu jauh, posisi jadi idle dan tidak menghasilkan apa-apa.

Bot ini memantau posisi tiap interval dan melakukan rebalance saat statusnya `OutOfRange`, supaya likuiditas kembali ke sekitar harga berjalan.

Status yang dilacak:

- `InRange` — aman, tidak ngapa-ngapain
- `NearEdge` — dekat tepi, masih ditunggu
- `OutOfRange` — rebalance
- `NoPosition` — mode pantau saja (tidak ada `POSITION_PUBKEY`)

## Cara kerja singkat

1. Tiap `CHECK_INTERVAL_MS`, bot cek active bin dan range posisi.
2. Kalau masih `InRange` / `NearEdge`, bot hanya log dan menunggu.
3. Kalau `OutOfRange`:
   - Withdraw 100% dari posisi (tanpa close).
   - Bagi target 50/50. Sisi yang berlebih di-swap lewat Jupiter.
   - Output swap yang berupa SOL mendarat sebagai native, jadi di-wrap ulang ke wSOL sebelum deposit.
   - Deposit lagi ke posisi yang sama, terpusat di active bin.
   - Fee hasil claim masuk ke wallet, tidak ikut di-deposit ulang (kecuali `COMPOUND_FEES=true`).
   - Native SOL tidak pernah turun di bawah saldo sebelum withdraw (atau `SOL_RESERVE_SOL`, mana yang lebih besar). Cuma hasil withdraw/swap di atasnya yang di-wrap dan ikut deposit. Isi wallet yang sudah ada sebelumnya tidak tersentuh.

Bot tidak pernah pakai saldo native SOL untuk sizing/deposit. Semua perhitungan pakai token account. Kalau gas kurang dari reserve, proses dibatalkan.

## Quickstart

```bash
bun install
cp .env.example .env
bun run index.ts
```

Isi minimal di `.env`:

```env
RPC_URL=https://api.mainnet-beta.solana.com
POOL_ADDRESS=...
```

Untuk live rebalance, tambahkan juga:

```env
POSITION_PUBKEY=...
WALLET_PRIVATE_KEY=...
DRY_RUN=false
```

> Default `DRY_RUN=true`, jadi aman untuk coba-coba. Bot hanya log rencana, tidak kirim transaksi.

## Konfigurasi

Semua lewat `.env`. Lihat `.env.example` untuk penjelasan tiap variabel.

| Variabel | Default | Keterangan |
|---|---|---|
| `RPC_URL` | wajib | RPC Solana (mainnet/devnet) |
| `POOL_ADDRESS` | wajib | Address pool DLMM yang dipantau |
| `POSITION_PUBKEY` | kosong | Kalau kosong, bot hanya mode pantau |
| `WALLET_PRIVATE_KEY` | kosong | Wajib untuk live. Bisa base58 (Phantom) atau JSON array |
| `DRY_RUN` | `true` | `true` = cuma log, `false` = kirim transaksi beneran |
| `STRATEGY` | `Spot` | `Spot` / `Curve` / `BidAsk` |
| `CHECK_INTERVAL_MS` | `60000` | Interval cek posisi |
| `EDGE_BUFFER_BINS` | `2` | Jarak dari tepi yang dianggap `NearEdge` |
| `SLIPPAGE_BPS` | `100` | Slippage live (1% = 100 bps) |
| `SWAP_SLIPPAGE_BPS` | ikut `SLIPPAGE_BPS` | Slippage khusus swap Jupiter |
| `POSITION_WIDTH_BINS` | ikut posisi lama | Lebar range baru. Kosong = pakai lebar posisi lama |
| `COMPOUND_FEES` | `false` | `false` = fee masuk wallet, `true` = fee ikut di-deposit |
| `SOL_RESERVE_SOL` | `0.02` | SOL yang disisakan untuk gas, tidak boleh kepakai |

Untuk Jupiter V2, API key tidak wajib. Kalau punya, cukup export di shell:

```bash
export JUPITER_API_KEY=...
```

Jangan taruh key di file atau commit ke git.

## Mode pantau vs live

- **Mode pantau:** `POSITION_PUBKEY` atau `WALLET_PRIVATE_KEY` kosong. Bot hanya log status pool/posisi.
- **Mode live:** isi keduanya dan set `DRY_RUN=false`. Bot akan withdraw → swap (Jupiter `/order` + sign lokal + `/execute`) → deposit lagi.

## Kalau swap gagal di tengah jalan?

Dana tetap aman di wallet dan posisi dalam keadaan kosong tapi masih hidup. Jangan withdraw ulang.

Lanjutkan manual dari kode dengan:

```ts
completeRebalanceFromWallet(ctx, config, snapshot, plan, walletBefore)
```

`walletBefore` adalah snapshot wallet sebelum withdraw `{ x, y, sol }` (`sol` = native sebelum withdraw, atau native saat ini kalau tidak tercatat — artinya native yang sudah ada tidak ikut di-wrap). Untuk `x`/`y` boleh `"0"` kalau tidak tercatat.

## Struktur project

```text
index.ts           # loop utama: cek snapshot -> decide -> eksekusi/log
src/config.ts      # baca & validasi .env
src/decision.ts    # logika InRange / NearEdge / OutOfRange
src/dlmm.ts        # koneksi Meteora DLMM, snapshot posisi
src/rebalance.ts   # withdraw, sizing 50/50, deposit in-place
src/swap.ts        # swap via Jupiter V2
src/log.ts         # format log
tests/             # unit test decision & rebalance
```

## Tech stack

- [Bun](https://bun.sh/) + TypeScript
- [@meteora-ag/dlmm](https://www.npmjs.com/package/@meteora-ag/dlmm) — SDK DLMM
- [@solana/web3.js](https://solana.com/docs) + SPL Token
- [Jupiter Ultra API](https://dev.jup.ag/docs/ultra/) — untuk swap
- [Effect](https://effect.website/) — flow async

Script yang tersedia:

```bash
bun test          # jalanin test
bun run check     # biome check
bun run lint      # biome lint
bun run format    # biome format
```

## Disclaimer

Bot ini berinteraksi langsung dengan mainnet dan dana asli. Pelajari dulu cara kerja DLMM dan risiko impermanent loss sebelum live. Mulai dari `DRY_RUN=true`, lalu coba dengan nominal kecil.
