# rebalance-dlmm-bot

Bot kecil buat jaga posisi DLMM Meteora. Dia pantau pool tiap interval. Kalau harga keluar dari range posisimu, dia rebalance otomatis pakai jalur native Meteora. Lebar range ikut posisi yang sudah ada. Tidak nambah bin.

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

## Dry run vs live

Default `DRY_RUN=true`. Bot cuma log rencana. Tidak kirim transaksi apa pun.

Mau live, isi `WALLET_PRIVATE_KEY` dan `POSITION_PUBKEY`, lalu set `DRY_RUN=false`. Kalau salah satu kosong, bot langsung berhenti dengan pesan jelas. Dia tidak nekat jalan setengah.

Live path pakai `simulateRebalancePositionWithBalancedStrategy` + `rebalancePosition`. Rebalance di tempat, posisi tidak ditutup. Fee dan slippage ikut aturan yang kamu set.

Strategi ikut SDK Meteora. `Spot` rata di semua bin. `Curve` numpuk di tengah, cocok harga anteng. `BidAsk` numpuk di tepi, cocok pair volatil atau DCA. Ganti lewat `STRATEGY` tanpa ubah kode.
