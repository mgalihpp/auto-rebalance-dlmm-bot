# rebalance-dlmm-bot

Bot kecil buat jaga posisi DLMM Meteora. Dia pantau pool tiap interval. Kalau harga keluar dari range posisimu, dia rebalance otomatis in place seperti modal Rebalance di Meteora: posisi yang sama dipertahankan, tidak ada close, tidak ada posisi baru. Lebar range ikut posisi yang sudah ada, terpusat di active bin. `POSITION_PUBKEY` kamu tetap valid setelah rebalance dan rent tidak hangus.

## Cara jalan

```bash
bun install
cp .env.example .env
bun run index.ts
```

Isi `.env` dulu:

| Var | Wajib | Isi |
|---|---|---|
| `RPC_URL` | ya | endpoint Solana, mainnet atau devnet |
| `POOL_ADDRESS` | ya | alamat pool, misal DOGE/SOL, lihat di app Meteora |
| `POSITION_PUBKEY` | live saja | alamat posisimu, kosong berarti mode pantau saja |
| `WALLET_PRIVATE_KEY` | live saja | private key base58 atau JSON array, jangan commit |
| `CHECK_INTERVAL_MS` | tidak | default 60000 |
| `STRATEGY` | tidak | `Spot`, `Curve`, atau `BidAsk`, default `Spot` |
| `SLIPPAGE_BPS` | tidak | default 100, cuma dipakai saat live |
| `DRY_RUN` | tidak | default true |
| `EDGE_BUFFER_BINS` | tidak | default 2 |
| `JUPITER_QUOTE_BASE_URL` | tidak | default `https://quote-api.jup.ag/v6` |
| `SWAP_SLIPPAGE_BPS` | tidak | default ikut `SLIPPAGE_BPS` |
| `POSITION_WIDTH_BINS` | tidak | kosong = ikut lebar posisi lama |
| `COMPOUND_FEES` | tidak | `true` atau `false`, default `false` |

## COMPOUND_FEES

Default `false`, sama seperti web Meteora. Fee tidak ikut diswap dan tidak ikut dideposit. Fee dibiarkan claimed di wallet.

- `false` = sizing dari pokok `totalX` dan `totalY` saja. TopUp = delta wallet minus `feeX` dan `feeY`, floor nol. Box dry run memuat baris fee.
- `true` = perilaku lama. Sizing dari total tambah fee dan topUp penuh dari delta wallet sehingga fee terkompaun.

Contoh baris fee di box saat `false`:

```text
├─ fees claimed X=0.2 / Y=0.1 (left in wallet)
```

## Status yang muncul di log

Satu baris per cek. Contoh:

```text
[BOOT] pool=... position=... edgeBuffer=2 interval=60000ms dryRun=true
[2026-09-11T07:00:00.000Z] status=InRange active=500 range=[480,520] decision=Hold reason="active bin 500 inside [480, 520]" dryRun=true
```

Artinya:

- `InRange`, harga masih di dalam. Bot diam.
- `NearEdge`, harga dekat tepi tapi masih di dalam. Bot diam, cuma info.
- `OutOfRange`, harga keluar range. Bot rebalance (atau log rencana kalau dry run).
- `NoPosition`, kamu belum isi `POSITION_PUBKEY`. Bot cuma pantau pool.

## Format log

Tag level stabil biar gampang di grep: `[BOOT] [HOLD] [REBALANCE] [DRY_RUN] [LIVE] [WARN] [ERROR] [CONFIG] [FATAL]`. Warna ANSI otomatis mati saat bukan TTY, `NO_COLOR` diset, atau `TERM=dumb`. Amount tampil dalam UI (base-unit dibagi decimals, trim nol, pemisah ribuan), mint disingkat `abcd...wxyz`, signature live disertai link Solscan.

```text
[HOLD] ts=2026-09-11T07:00:00.000Z status=InRange active=500 range=[480,520] reason="active bin 500 inside [480, 520]"
[DRY_RUN] rebalance preview ─ pool=4n9r...GX5d6 active=500
```

## Dry run vs live

Default `DRY_RUN=true`. Bot cuma log rencana. Tidak kirim transaksi apa pun.

Mau live, isi `WALLET_PRIVATE_KEY` dan `POSITION_PUBKEY`, lalu set `DRY_RUN=false`. Kalau salah satu kosong, bot langsung berhenti dengan pesan jelas. Dia tidak nekat jalan setengah.

Live path 3 tahap, satu owner, posisi yang sama dipertahankan: tarik 100% tanpa close (posisi tetap hidup walau kosong), swap kelebihan satu sisi via Jupiter, lalu rebalance in place via SDK (`simulateRebalancePositionWithBalancedStrategy` + `rebalancePosition`) dengan haircut penuh sehingga deposit murni dari topUp aktual (selisih saldo wallet sesudah swap vs snapshot sebelum tarik). Hasilnya bar seimbang di kedua sisi pool price. Fee dan slippage ikut aturan yang kamu set. Karena tidak ada close dan tidak ada posisi baru, pubkey posisi tetap valid dan rent tidak hangus.

## Balanced rebalance

OutOfRange selalu rebalance in place. Kalau posisi single-sided (harga jauh keluar range), swap menyeimbangkan kedua sisi sebelum deposit ulang ke posisi yang sama.

Strategi ikut SDK Meteora. `Spot` rata di semua bin. `Curve` numpuk di tengah, cocok harga anteng. `BidAsk` numpuk di tepi, cocok pair volatil atau DCA. Ganti lewat `STRATEGY` tanpa ubah kode.
