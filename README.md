# Bot Telegram YouTube Downloader — GitHub Repo + Cloudflare Workers

Arsitektur **tanpa server / VPS**:

```
User ──link──▶ Telegram ──webhook──▶ Cloudflare Worker ──trigger──▶ GitHub Actions
                                          │                              │
                                          │◀── tombol format ────────────┤ yt-dlp + ffmpeg
                                          │                              │ download + convert
User ◀──────────── file video / audio ────┴──────── Telegram Bot API ◀───┘
```

## Kenapa dibagi dua?

Cloudflare Workers **tidak bisa** menjalankan yt-dlp / ffmpeg: tidak ada binary
native, tidak ada filesystem persisten, memori 128 MB, CPU plan gratis 10 ms.
Jadi Worker hanya jadi *penerima pesan* (ringan, selalu online, gratis),
sedangkan download beratnya dijalankan GitHub Actions (ada Python, ffmpeg,
disk, dan gratis untuk repo publik).

Konsekuensinya: tidak instan. Setiap download butuh **±1–3 menit**
(start runner GitHub + download + upload). Untuk bot pribadi / komunitas
kecil ini wajar; untuk trafik besar, VPS tetap lebih cocok.

## Struktur repo

```
.
├── wrangler.toml          # konfigurasi Worker — WAJIB di root (dibaca Cloudflare Builds)
├── package.json
├── worker/
│   └── src/index.js       # webhook Telegram + trigger Actions (stateless)
├── downloader/
│   ├── download.py        # yt-dlp + kirim file ke Telegram (dijalankan Actions)
│   └── requirements.txt
└── .github/workflows/
    ├── download.yml       # workflow_dispatch: chat_id, youtube_url, format_choice
    └── deploy-worker.yml  # deploy Worker otomatis saat push ke main
```

## Setup — urutannya penting

### 1. Buat repo & push project ini

Buat dulu repo **43VfQLAv0MTy/yt-downloader-bot** di GitHub (kosong, tanpa README /
.gitignore / license bawaan) kalau belum ada — per 19 Nov 2026 repo ini belum
terlihat publik. Project lokal di ZIP ini sudah `git init` + commit + remote,
jadi dari folder project tinggal:

```bash
git push -u origin main
```

> Workflow `download.yml` harus sudah ada di branch `main` (default branch)
> sebelum bisa dipicu lewat API.

### 2. Isi secrets di GitHub repo

Di repo: **Settings → Secrets and variables → Actions → New repository secret**

| Secret | Isi |
|---|---|
| `TELEGRAM_BOT_TOKEN` | Token dari @BotFather (dipakai downloader untuk kirim file) |
| `API_ID` | (Opsional) API ID dari my.telegram.org — untuk kirim file besar 50 MB–2 GB via MTProto |
| `API_HASH` | (Opsional) API Hash dari my.telegram.org — pasangan API_ID |
| `OPENVPN_CONFIG` | (Opsional) Isi lengkap file `.ovpn` — untuk pilihan "Download pakai OpenVPN" |
| `OPENVPN_USER` | (Opsional) Username OpenVPN, bila config di atas butuh login |
| `OPENVPN_PASS` | (Opsional) Password OpenVPN, pasangan OPENVPN_USER |
| `CLOUDFLARE_API_TOKEN` | Token Cloudflare dengan izin *Edit Cloudflare Workers* (hanya untuk deploy otomatis) |
| `CLOUDFLARE_ACCOUNT_ID` | Account ID di dashboard Cloudflare (hanya untuk deploy otomatis) |

### 3. Siapkan token GitHub untuk Worker

Worker butuh token untuk memicu workflow. Buat **fine-grained PAT**:
GitHub → Settings → Developer settings → Personal access tokens → Fine-grained

- Repository access: hanya repo ini
- Permissions: **Actions → Read and write**
- Salin tokennya (dipakai di langkah 4, jangan commit ke repo!)

### 4. Deploy Worker ke Cloudflare

`wrangler.toml` di root repo sudah diisi untuk repo ini: `GITHUB_OWNER = "43VfQLAv0MTy"`, `GITHUB_REPO = "yt-downloader-bot"`, `main = "worker/src/index.js"`.

Cara A — otomatis: push ke `main`, workflow `deploy-worker.yml` akan deploy.

Cara B — manual dari komputer kamu:

```bash
# dari root repo (bukan dari folder worker/)
npx wrangler login
npx wrangler secret put TELEGRAM_BOT_TOKEN
npx wrangler secret put TELEGRAM_WEBHOOK_SECRET   # isi string acak panjang, catat!
npx wrangler secret put GITHUB_TOKEN              # fine-grained PAT dari langkah 3
npx wrangler deploy
```

Catat URL Worker yang keluar, contoh: `https://youtube-telegram-bot.<akun>.workers.dev`

> Kalau deploy lewat cara A, set ketiga secret di atas lewat
> **Cloudflare Dashboard → Workers & Pages → youtube-telegram-bot → Settings → Variables and Secrets**.

### 5. Daftarkan webhook Telegram

Setelah Worker online dan secret terisi, buka di browser:

```
https://youtube-telegram-bot.<akun>.workers.dev/set-webhook?secret=<TELEGRAM_WEBHOOK_SECRET kamu>
```

Balasan JSON dengan `"ok": true` artinya webhook berhasil dipasang.
Setelah ini bot tidak lagi pakai polling — versi `bot.py` lama jangan dijalankan bersamaan.

### 6. Tes

1. Chat `/start` ke bot → harus dibalas Worker (cepat).
2. Kirim link YouTube → bot menampilkan 6 pilihan cara download
   (tanpa proxy / proxy custom / OpenVPN tersimpan / custom config /
   config dari link / batal). Pilih salah satu.
3. ±1 menit kemudian muncul foto + tombol format dinamis dari run **probe**
   (probe memakai cara yang kamu pilih tadi):
   hanya resolusi yang benar-benar tersedia (maks 4320p/8K), tiap tombol
   ada perkiraan ukurannya.
4. Klik format → download langsung jalan dengan cara yang sama seperti
   saat cek (kecuali config OpenVPN custom — config-nya perlu dikirim
   ulang saat bot menanyakannya lagi setelah klik format); Worker
   membalas "sedang diproses di GitHub Actions".
5. Cek tab **Actions** di repo: run `YouTube Download` harus muncul.
6. File terkirim ke chat setelah run selesai.

## Pilihan format

🎬 Video dinamis per video (144p s/d 4320p, hanya yang tersedia) lengkap
dengan perkiraan ukuran — 🎵 Audio MP3 / M4A 192kbps.
File s/d **50 MB** dikirim lewat Bot API; file 50 MB–2 GB dikirim lewat
jalur MTProto bila secret `API_ID`/`API_HASH` terpasang (lihat bagian
secrets); di atas 2 GB ditolak dengan pesan saran turun kualitas /
pilih audio.

## Proxy & VPN (opsional)

Saat user mengirim link, bot **langsung** menawarkan 6 pilihan cara —
cara itu dipakai dulu untuk probe (cek kualitas), lalu dipakai lagi
untuk download setelah user mengklik format. Sebelumnya probe selalu
jalan tanpa proxy, jadi sering mentok bot-check YouTube ("Sign in to
confirm you're not a bot") sebelum user sempat memilih proxy/VPN;
sekarang probe sudah berjalan lewat cara yang dipilih. Satu
pengecualian: config OpenVPN custom tidak bisa dibawa dari probe ke
download (bot tidak menyimpan config, dan tombol Telegram dibatasi
64 byte), jadi setelah klik format bot menanyakan lagi cara
download-nya. Bila probe gagal, pesan gagalnya menampilkan keenam
tombol yang sama, jadi user bisa langsung mencoba cara lain tanpa
mengirim link ulang.

- **⬇️ Download tanpa proxy** — langsung diproses tanpa proxy.
- **🔌 Download menggunakan proxy custom** — bot membalas dengan pesan
  perintah (force reply); user membalasnya dengan URL proxy
  (`skema://[user:pass@]host:port`; skema `http`, `https`, `socks4`,
  `socks4a`, `socks5`, `socks5h`), lalu download berjalan memakai
  proxy itu. Pesan perintah membawa kode tugas `px:<videoId>:<choice>`
  yang dibaca Worker dari pesan yang dibalas — tanpa penyimpanan
  antar-request. **Bulk proxy:** user boleh mengirim beberapa proxy
  sekaligus (satu per baris, atau dipisah spasi/koma; maks 10) —
  downloader mencoba satu-satu sampai ada yang berhasil; bila sudah
  berhasil, proxy yang belum dipakai diabaikan, dan bot mengirim
  laporan: mana yang gagal (+alasannya), mana yang berhasil, dan mana
  yang belum dicoba. Proxy yang berhasil saat probe dibawa tombol
  format, jadi download langsung memakai proxy itu tanpa mencoba
  ulang daftarnya.
- **🛡️ Gunakan profile OpenVPN yang tersimpan** — workflow
  menyambungkan OpenVPN sebelum download dan memutuskannya
  sesudahnya; seluruh trafik download berjalan lewat VPN. Config-nya
  berasal dari secret repo `OPENVPN_CONFIG` (isi lengkap file
  `.ovpn`); bila config butuh login, isi juga secret `OPENVPN_USER`
  dan `OPENVPN_PASS`. Untuk mengganti server, ganti saja isi secret
  `OPENVPN_CONFIG`.
- **📄 Gunakan custom config OpenVPN** — user membalas prompt bot
  dengan config `.ovpn` miliknya dalam salah satu dari tiga bentuk:
  file (dikirim sebagai dokumen), tempelan teks config, atau link
  raw (Worker mengambil isi config dari link itu; maks 100 KB).
  Worker meneruskan isi config ke workflow sebagai input
  `ovpn_config` (mendahului secret). Bila config mengandung baris
  `auth-user-pass`, bot meminta username + password dalam satu
  balasan lagi — prompt kedua membawa serta config-nya karena Worker
  tidak punya penyimpanan: `file_id` config-nya
  (`ovpnfile:<file_id>`, isi config tetap di Telegram dan baru
  diunduh Worker saat kredensial tiba) untuk config berkas, atau isi
  config tersemat di antara penanda `ovpncfg:begin`/`ovpncfg:end`
  untuk config teks sampai ±3.500 karakter (di atas itu user diminta
  mengirim sebagai file), atau URL config-nya (`ovpnurl:<url>`,
  config diambil ulang saat kredensial tiba) untuk config dari
  link. Bila config tidak butuh login, download langsung dimulai.
  Validasi config menerima format SoftEther/VPNGate (direktif
  `client` boleh berada di tengah baris gabungan).
- **🌐 Download config OpenVPN dari link** — user membalas prompt
  dengan URL unduhan config saja (mis. link VPNGate); Worker
  mengambil config-nya dari link itu, lalu alurnya sama seperti
  custom config dari link di atas.
- **✖️ Batalkan / Cancel tugas** — membatalkan tugas.

Bila download gagal, pesan gagal dari downloader memasang lagi
keenam tombol yang sama, jadi user bisa langsung mencoba cara lain
(mis. ganti dari tanpa proxy ke proxy custom / OpenVPN) tanpa
mengulang dari awal.

## Troubleshooting

| Gejala | Cek |
|---|---|
| Cloudflare Builds gagal: `Could not detect a directory containing static files` | `npx wrangler deploy` jalan dari root repo tapi `wrangler.toml` tidak ditemukan di root — pastikan `wrangler.toml` ada di root (bukan hanya di subfolder) dengan `main = "worker/src/index.js"`, atau set *Root directory* = `worker` di Settings → Builds bila memakai struktur lama |
| Probe gagal "Sign in to confirm you're not a bot" | IP runner GitHub sedang diblokir YouTube. Pilih proxy custom / OpenVPN saat kirim link (probe memakai cara itu); pesan gagal probe juga menampilkan keenam tombol untuk mencoba cara lain tanpa kirim link ulang |
| Klik tombol → "Gagal memulai download (HTTP 404)" | `GITHUB_OWNER`/`GITHUB_REPO` salah, atau `download.yml` belum ada di branch `main` |
| Klik tombol → HTTP 401/403 | `GITHUB_TOKEN` kedaluwarsa / tidak punya izin Actions: write |
| Run Actions gagal di langkah kirim | Secret `TELEGRAM_BOT_TOKEN` di repo kosong / salah |
| Bot tidak merespons sama sekali | Webhook belum dipasang (langkah 5) atau `TELEGRAM_WEBHOOK_SECRET` di Worker tidak sama dengan yang dipakai saat set-webhook |
| Mau batasi pengguna | Set var `ALLOWED_USER_IDS` di `wrangler.toml` (ID Telegram pisah koma), deploy ulang |
| Kuota Actions | Repo publik: gratis di runner standar. Repo privat: jatah plan (umumnya 2.000 menit/bulan di Free) — satu download ±1–3 menit |

## Keamanan

- Semua token disimpan sebagai **secret** (GitHub Secrets / Worker Secrets), tidak ada di kode.
- Webhook diverifikasi pakai header `X-Telegram-Bot-Api-Secret-Token`.
- Input dari Worker diteruskan ke Actions lewat `env:`, bukan ditempel ke perintah shell.
