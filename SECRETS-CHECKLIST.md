# Checklist Secrets & Variables — yt-downloader-bot

Repo: `43VfQLAv0MTy/yt-downloader-bot` — Worker: `youtube-telegram-bot`

## A. GitHub Repo — Secrets

Tempat: repo → **Settings → Secrets and variables → Actions → New repository secret**

| Nama | Wajib? | Isi | Dipakai oleh |
|---|---|---|---|
| `TELEGRAM_BOT_TOKEN` | ✅ Wajib | Token dari @BotFather | `download.yml` → `downloader/download.py` untuk mengirim file ke Telegram |
| `YOUTUBE_COOKIES` | Opsional — cadangan terakhir | Isi file cookies.txt YouTube (format Netscape) dari akun Google **cadangan/burner**, diekspor pakai ekstensi "Get cookies.txt LOCALLY" | `download.yml` → ditulis ke file sementara → `download.py` memakainya bila rotasi client + PO-token masih kena bot-check YouTube. **Jangan pakai akun utama** (akun yang dipakai otomatisasi berisiko dibatasi YouTube) dan jangan pernah commit / kirim isi cookies ke chat |
| `CLOUDFLARE_API_TOKEN` | Hanya untuk deploy otomatis | API Token Cloudflare (izin Edit Workers) | `deploy-worker.yml` |
| `CLOUDFLARE_ACCOUNT_ID` | Hanya untuk deploy otomatis | Account ID Cloudflare | `deploy-worker.yml` |

> Kalau deploy Worker dilakukan manual pakai `npx wrangler deploy`, dua secret
> Cloudflare di atas **tidak perlu** diisi di GitHub.
> Di GitHub **tidak ada Variables** yang wajib diisi untuk project ini.

## B. Cloudflare Worker — Secrets (terenkripsi)

Tempat: Dashboard → **Workers & Pages → youtube-telegram-bot → Settings →
Variables and Secrets** — atau `npx wrangler secret put <NAMA>`

| Nama | Isi |
|---|---|
| `TELEGRAM_BOT_TOKEN` | Token yang **sama** dengan di GitHub (Worker memakainya untuk balas pesan / kirim tombol ke Telegram) |
| `TELEGRAM_WEBHOOK_SECRET` | String acak panjang buatanmu sendiri (contoh: hasil password generator, 32+ karakter). Dipakai juga saat membuka `/set-webhook?secret=...` |
| `GITHUB_TOKEN` | Fine-grained PAT: hanya repo `yt-downloader-bot`, permission **Actions: Read and write** |

## C. Cloudflare Worker — Variables (teks biasa, sudah diisi di `wrangler.toml`)

| Nama | Nilai |
|---|---|
| `GITHUB_OWNER` | `43VfQLAv0MTy` |
| `GITHUB_REPO` | `yt-downloader-bot` |
| `GITHUB_REF` | `main` |
| `ALLOWED_USER_IDS` | *(kosong = semua boleh)* — isi ID Telegram pisah koma kalau mau dibatasi |

## D. BUKAN secret — jangan diisi manual

`CHAT_ID`, `YOUTUBE_URL`, `FORMAT_CHOICE` di downloader **bukan** pengaturan.
Nilainya dikirim otomatis: Worker → workflow_dispatch inputs → env di
`download.yml` → `downloader/download.py`.

## Ringkasan jumlah

- GitHub: **1 secret wajib** (+2 kalau mau deploy otomatis)
- Cloudflare Worker: **3 secret + 4 variable** (variable sudah tertulis di `wrangler.toml`)
- Nilai yang sama di dua tempat: hanya `TELEGRAM_BOT_TOKEN`
