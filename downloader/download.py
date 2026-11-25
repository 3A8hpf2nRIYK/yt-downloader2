#!/usr/bin/env python3
"""
Downloader untuk GitHub Actions — dipanggil oleh .github/workflows/download.yml

Input lewat environment variable (bukan argumen shell, agar aman dari injection):
  MODE                download (default) | probe
  CHAT_ID             ID chat Telegram tujuan
  YOUTUBE_URL         link YouTube
  FORMAT_CHOICE       vid_best | vid_1080 | vid_720 | vid_480 | vid_360 |
                      aud_mp3 | aud_m4a | v<tinggi> dinamis (mis. v2160, v1080)
  PROBE_MESSAGE_ID    (mode probe) ID pesan placeholder dari Worker untuk
                      dihapus / diedit setelah hasil probe siap
  TELEGRAM_BOT_TOKEN  (secret repo) token bot
  API_ID, API_HASH    (opsional, secret repo) kredensial my.telegram.org
                      untuk jalur kirim file besar via MTProto (Telethon,
                      login sebagai bot): file 50 MB - 2 GB bisa dikirim.
                      Tanpa ini, batas kirim tetap 50 MB (Bot API).
  YT_COOKIES_FILE     (opsional) path file cookies YouTube dari secret
  PROXY               (opsional) proxy untuk yt-dlp — satu URL, atau
                      DAFTAR (bulk) dipisah spasi / baris baru / koma.
                      Dipilih user ("Download menggunakan proxy custom")
                      lalu diteruskan Worker ke sini. Proxy dicoba
                      satu-satu sampai ada yang berhasil (rotasi); bila
                      sudah berhasil, proxy yang belum dipakai diabaikan,
                      dan hasilnya dilaporkan ke Telegram (gagal /
                      berhasil / belum dicoba). Skema: http, https,
                      socks4, socks4a, socks5, socks5h. Kosong = tanpa proxy.

Mode download: kirim pesan status -> yt-dlp download + convert (ffmpeg) ->
cek batas ukuran -> kirim file ke Telegram -> hapus pesan status.
Pengiriman: <=50 MB via Bot API; 50 MB - 2 GB via MTProto/Telethon
(bila API_ID/API_HASH terpasang); di atas 2 GB ditolak.
Sebelum kirim, metadata video (durasi/lebar/tinggi dari ffprobe) dan
satu frame thumbnail dilampirkan ke sendVideo — tanpa itu Telegram di
HP bisa menampilkan durasi 0:00 dan pratinjau kosong.

Mode probe: ekstrak info video (tanpa download) memakai proxy/VPN yang
dipilih user saat kirim link (bukan tanpa proxy seperti dulu) -> hitung
resolusi yang BENAR-BENAR tersedia (maks 4320p/8K) + perkiraan ukuran
tiap format -> kirim foto + tombol format dinamis ke Telegram. Bila
user mengirim bulk proxy, probe mencoba satu-satu sampai ada yang
berhasil; proxy yang berhasil dibawa tombol format
("dl:<id>:<choice>|<n|v|p<proxy>>") supaya klik format langsung
download dengan cara yang sama, dan laporan proxy (gagal / berhasil /
belum dicoba) dikirim sebagai pesan terpisah. Bila probe memakai config
OpenVPN custom, tombolnya polos (config tidak bisa dibawa lewat
callback Telegram, maks 64 byte) dan Worker menampilkan lagi menu
cara download. Bila probe gagal (mis. bot-check YouTube), pesan gagalnya
memasang menu cara probe ("pre:<id>:<aksi>") supaya user bisa langsung
mencoba cara lain tanpa mengirim link ulang.
"""

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

import requests
import yt_dlp

MAX_SIZE_SAFE = 49 * 1024 * 1024
# Batas jalur MTProto: Telegram mengizinkan file s.d. 2 GB.
MAX_SIZE_MTPROTO = 2000 * 1000 * 1000

FORMAT_CHOICES = {
    "vid_best": {
        "label": "🎬 Video - Terbaik", "kind": "video",
        "format": "bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best",
    },
    "vid_1080": {
        "label": "🎬 Video - 1080p", "kind": "video",
        "format": "bestvideo[height<=1080][ext=mp4]+bestaudio[ext=m4a]/best[height<=1080][ext=mp4]/best[height<=1080]",
    },
    "vid_720": {
        "label": "🎬 Video - 720p", "kind": "video",
        "format": "bestvideo[height<=720][ext=mp4]+bestaudio[ext=m4a]/best[height<=720][ext=mp4]/best[height<=720]",
    },
    "vid_480": {
        "label": "🎬 Video - 480p", "kind": "video",
        "format": "bestvideo[height<=480][ext=mp4]+bestaudio[ext=m4a]/best[height<=480][ext=mp4]/best[height<=480]",
    },
    "vid_360": {
        "label": "🎬 Video - 360p", "kind": "video",
        "format": "bestvideo[height<=360][ext=mp4]+bestaudio[ext=m4a]/best[height<=360][ext=mp4]/best[height<=360]",
    },
    "aud_mp3": {
        "label": "🎵 Audio - MP3", "kind": "audio",
        "format": "bestaudio/best", "codec": "mp3", "quality": "192",
    },
    "aud_m4a": {
        "label": "🎵 Audio - M4A", "kind": "audio",
        "format": "bestaudio[ext=m4a]/bestaudio/best", "codec": "m4a", "quality": "192",
    },
}

_DYNAMIC_RE = re.compile(r"^v(\d{3,4})$")


def resolve_choice(choice_key: str) -> dict | None:
    """Terima pilihan statis FORMAT_CHOICES atau dinamis v<tinggi> (mis. v1440)."""
    if choice_key in FORMAT_CHOICES:
        return FORMAT_CHOICES[choice_key]
    m = _DYNAMIC_RE.match(choice_key or "")
    if m:
        h = int(m.group(1))
        if 144 <= h <= 4320:
            return {
                "label": f"🎬 Video - {h}p", "kind": "video",
                "format": (f"bestvideo[height<={h}][ext=mp4]+bestaudio[ext=m4a]"
                           f"/best[height<={h}][ext=mp4]/best[height<={h}]"),
            }
    return None


# Rencana percobaan download: (player_client, pakai_cookies, fetch_pot).
# Pelajaran dari log Actions 20 Nov 2026:
# - Tanpa cookies, semua client kena bot-check dari IP Actions — kecuali
#   bila IP runner sedang bersih, `visionos` memberi format paling lengkap.
# - Dengan cookies, ekstraksi lolos, tapi format dari chain default authed
#   (web_embedded, tv_samsung, web) saat diunduh kena HTTP 403: format
#   client web butuh PO-token (GVS) yang mengikat URL-nya, dan tv_samsung
#   BUKAN client WebPO jadi formatnya tidak bisa diotorisasi bgutil.
# - Client yang PO-tokennya bisa dibuat bgutil (WEBPO_CLIENTS di yt-dlp):
#   web, mweb, tv, web_embedded, web_creator, web_music, tv_simply.
#   Untuk mereka fetch_pot dipaksa "always" (default "auto" sering tidak
#   meminta token sama sekali).
ATTEMPT_PLAN: list[tuple[list[str] | None, bool, bool]] = [
    (["visionos"], True, False),
    (["visionos"], False, False),
    (["web"], True, True),
    (["mweb"], True, True),
    (["tv"], True, True),
    (["web_embedded"], True, True),
    (None, True, True),            # default yt-dlp + cookies + POT
    (["android_vr"], False, False),
    (None, False, False),          # default yt-dlp polos (IP bersih)
]

TOKEN = os.environ.get("TELEGRAM_BOT_TOKEN", "").strip()
API = f"https://api.telegram.org/bot{TOKEN}"
API_ID = os.environ.get("API_ID", "").strip()
API_HASH = os.environ.get("API_HASH", "").strip()


def tg_post(method: str, **kwargs) -> dict:
    r = requests.post(f"{API}/{method}", timeout=120, **kwargs)
    data = r.json() if r.headers.get("content-type", "").startswith("application/json") else {}
    if not data.get("ok"):
        print(f"Telegram {method} gagal: {data}", file=sys.stderr)
    return data


def send_text(chat_id: str, text: str, reply_markup: dict | None = None) -> int | None:
    payload: dict = {"chat_id": chat_id, "text": text, "parse_mode": "HTML"}
    if reply_markup:
        payload["reply_markup"] = reply_markup
    data = tg_post("sendMessage", json=payload)
    return (data.get("result") or {}).get("message_id")


def edit_text(chat_id: str, message_id: int | None, text: str,
              reply_markup: dict | None = None) -> None:
    if message_id:
        payload = {
            "chat_id": chat_id, "message_id": message_id,
            "text": text, "parse_mode": "HTML",
        }
        if reply_markup:
            payload["reply_markup"] = reply_markup
        tg_post("editMessageText", json=payload)


_VIDEO_ID_RE = re.compile(
    r"(?:youtube\.com/(?:watch\?[^ \n]*v=|shorts/|live/|embed/)|youtu\.be/)([\w-]{11})",
    re.IGNORECASE,
)


def download_choice_keyboard(video_id: str, choice_key: str) -> dict:
    """Tombol 6 cara download (callback px:<vid>:<choice>:<n|c|v|o|l|x>)
    — sama seperti yang dibuat Worker setelah resolusi diklik. Dipasang
    pada pesan gagal supaya user bisa langsung mencoba cara lain
    (mis. tanpa proxy -> proxy custom / OpenVPN) tanpa mengulang dari
    awal."""
    return {"inline_keyboard": [
        [{"text": "⬇️ Download tanpa proxy",
          "callback_data": f"px:{video_id}:{choice_key}:n"}],
        [{"text": "🔌 Download menggunakan proxy custom",
          "callback_data": f"px:{video_id}:{choice_key}:c"}],
        [{"text": "🛡️ Gunakan profile OpenVPN yang tersimpan",
          "callback_data": f"px:{video_id}:{choice_key}:v"}],
        [{"text": "📄 Gunakan custom config OpenVPN",
          "callback_data": f"px:{video_id}:{choice_key}:o"}],
        [{"text": "🌐 Download config OpenVPN dari link",
          "callback_data": f"px:{video_id}:{choice_key}:l"}],
        [{"text": "✖️ Batalkan / Cancel tugas",
          "callback_data": f"px:{video_id}:{choice_key}:x"}],
    ]}


def probe_choice_keyboard(video_id: str) -> dict:
    """Tombol 6 cara probe (callback pre:<vid>:<n|c|v|o|l|x>) — sama
    seperti yang dibuat Worker saat link pertama dikirim. Dipasang
    pada pesan gagal probe supaya user bisa langsung mencoba cara lain
    (mis. tanpa proxy -> proxy custom / OpenVPN) tanpa mengirim link
    ulang."""
    return {"inline_keyboard": [
        [{"text": "⬇️ Download tanpa proxy",
          "callback_data": f"pre:{video_id}:n"}],
        [{"text": "🔌 Download menggunakan proxy custom",
          "callback_data": f"pre:{video_id}:c"}],
        [{"text": "🛡️ Gunakan profile OpenVPN yang tersimpan",
          "callback_data": f"pre:{video_id}:v"}],
        [{"text": "📄 Gunakan custom config OpenVPN",
          "callback_data": f"pre:{video_id}:o"}],
        [{"text": "🌐 Download config OpenVPN dari link",
          "callback_data": f"pre:{video_id}:l"}],
        [{"text": "✖️ Batalkan / Cancel tugas",
          "callback_data": f"pre:{video_id}:x"}],
    ]}


def fmt_size(n: int) -> str:
    return f"{n / (1024 * 1024):.1f} MB"


def fmt_duration(sec: int | None) -> str:
    if not sec:
        return "-"
    sec = int(sec)
    h, rem = divmod(sec, 3600)
    m, s = divmod(rem, 60)
    return f"{h}:{m:02d}:{s:02d}" if h else f"{m}:{s:02d}"


def escape_html(t: str) -> str:
    return (t or "").replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def probe_video_metadata(path: Path) -> dict:
    """Durasi & dimensi video dari ffprobe, untuk atribut sendVideo.

    Telegram mengambil durasi dari atribut pesan; bila server gagal
    membacanya dari file (dan bot tidak memberikannya), klien di HP
    menampilkan 0:00. Memberikannya secara eksplisit menghindari itu.
    """
    meta = {"duration": 0, "width": 0, "height": 0}
    if not shutil.which("ffprobe"):
        return meta
    try:
        out = subprocess.run(
            ["ffprobe", "-v", "error", "-select_streams", "v:0",
             "-show_entries", "stream=width,height:format=duration",
             "-of", "json", str(path)],
            capture_output=True, text=True, timeout=30,
        )
        data = json.loads(out.stdout or "{}")
        stream = (data.get("streams") or [{}])[0]
        meta["width"] = int(stream.get("width") or 0)
        meta["height"] = int(stream.get("height") or 0)
        meta["duration"] = int(round(float((data.get("format") or {}).get("duration") or 0)))
    except Exception as e:  # noqa: BLE001 - metadata gagal tidak boleh menggagalkan kirim
        print(f"ffprobe metadata gagal: {e}", file=sys.stderr)
    return meta


def make_thumbnail(path: Path, duration: int, out_dir: Path) -> Path | None:
    """Satu frame video sebagai thumbnail sendVideo (JPEG, lebar 320 px,
    maks 200 KB sesuai syarat Bot API). None bila gagal."""
    if not shutil.which("ffmpeg"):
        return None
    thumb = out_dir / "thumb.jpg"
    ss = max(1, min(5, duration // 4)) if duration else 1
    try:
        subprocess.run(
            ["ffmpeg", "-y", "-ss", str(ss), "-i", str(path),
             "-frames:v", "1", "-vf", "scale=320:-2", "-q:v", "5", str(thumb)],
            capture_output=True, timeout=60,
        )
        if thumb.is_file() and 0 < thumb.stat().st_size <= 200 * 1024:
            return thumb
    except Exception as e:  # noqa: BLE001
        print(f"Thumbnail gagal dibuat: {e}", file=sys.stderr)
    return None


def mtproto_ready() -> bool:
    """Jalur kirim file besar (MTProto) siap bila API_ID/API_HASH terisi."""
    return bool(API_ID.isdigit() and API_HASH and TOKEN)


async def _send_large_async(chat_id: str, file_path: Path, caption: str,
                            kind: str, meta: dict, thumb: Path | None) -> None:
    from telethon import TelegramClient
    from telethon.sessions import StringSession
    from telethon.tl.types import DocumentAttributeAudio, DocumentAttributeVideo

    attrs = None
    if kind == "video":
        attrs = [DocumentAttributeVideo(
            duration=meta.get("duration") or 0,
            w=meta.get("width") or 0,
            h=meta.get("height") or 0,
            supports_streaming=True,
        )]
    elif kind == "audio" and meta.get("duration"):
        attrs = [DocumentAttributeAudio(duration=meta["duration"])]
    # Login sebagai BOT memakai token yang sama seperti Bot API; sesi
    # kosong di memori, jadi SESSION_STRING tidak diperlukan dan tidak
    # ada akun pribadi yang dipakai.
    # PENTING: jangan pakai "async with TelegramClient(...)" di sini —
    # __aenter__ memanggil start() TANPA argumen, yang membuat Telethon
    # meminta nomor HP/token secara interaktif dan langsung EOFError di
    # runner non-interaktif (kejadian live 2026-11-22, run 44933412518).
    client = TelegramClient(StringSession(), int(API_ID), API_HASH)
    await client.start(bot_token=TOKEN)
    try:
        await client.send_file(
            int(chat_id), str(file_path),
            caption=caption, parse_mode="html",
            thumb=str(thumb) if thumb else None,
            attributes=attrs,
            supports_streaming=(kind == "video"),
        )
    finally:
        await client.disconnect()


def drop_vpn_before_upload() -> None:
    """Putuskan OpenVPN tepat sebelum upload ke Telegram.

    Pola yang diminta Rendy, terbukti perlu dari run live 44938274594
    (2026-11-22): download 109,82 MB lewat tunnel VPNBook selesai dalam
    70 detik, tetapi upload MTProto lewat tunnel yang sama tidak selesai
    dalam 10+ menit dan run dibatalkan manual. Jadi VPN hanya dipakai
    untuk mengambil video dari YouTube; pengiriman file ke Telegram
    berjalan lewat IP asli runner yang jauh lebih cepat dan stabil.
    No-op bila run ini tidak memakai VPN (tidak ada file pid OpenVPN).
    Step "Putuskan OpenVPN" di workflow tetap berjalan sesudahnya dan
    mentoleransi VPN yang sudah mati (semua perintahnya `|| true`).
    """
    import time
    tmp = os.environ.get("RUNNER_TEMP", "").strip()
    if not tmp:
        return
    pid_file = Path(tmp) / "openvpn.pid"
    if not pid_file.is_file():
        return
    try:
        pid = pid_file.read_text(encoding="utf-8", errors="ignore").strip()
        if pid.isdigit():
            subprocess.run(["sudo", "kill", pid], check=False, timeout=15)
        time.sleep(2)
        subprocess.run(["sudo", "pkill", "-x", "openvpn"], check=False, timeout=15)
        time.sleep(1)
        print("OpenVPN diputuskan sebelum upload; kirim file lewat IP asli runner.")
    except Exception as e:
        print(f"(Tidak bisa memutuskan VPN sebelum upload, lanjut apa adanya: {e})")


def send_large(chat_id: str, file_path: Path, caption: str,
               kind: str, meta: dict, thumb: Path | None) -> None:
    """Kirim file 50 MB - 2 GB lewat MTProto (Telethon, login bot)."""
    import asyncio
    asyncio.run(_send_large_async(chat_id, file_path, caption, kind, meta, thumb))


def _cookies_file() -> str | None:
    """Path file cookies YouTube dari env YT_COOKIES_FILE, bila ada & terisi."""
    path = os.environ.get("YT_COOKIES_FILE", "").strip()
    if path and Path(path).is_file() and Path(path).stat().st_size > 0:
        return path
    return None


_PROXY_RE = re.compile(r"^(https?|socks4a?|socks5h?)://\S+$", re.IGNORECASE)
# Format 4-bagian dari banyak penjual proxy: host:port:user:pass (kadang
# ditempel skema). Harus diubah ke URL standar user:pass@host:port —
# kalau tidak, potongan terakhir (password) terbaca sebagai port dan
# semua percobaan gagal ("Port could not be cast to integer", kejadian
# live 2026-11-22 run 45018945676). Worker sudah menormalisasi di pintu
# masuk; ini lapis kedua untuk jalur masuk lain.
_PROXY_COLON_RE = re.compile(
    r"^(?:(https?|socks4a?|socks5h?)://)?([\w.-]+):(\d{1,5}):([^\s:@/]+):([^\s:@/]+)$",
    re.IGNORECASE)
_PROXY_BARE_AUTH_RE = re.compile(r"^[^\s:@/]+:[^\s:@/]+@[\w.-]+:\d{1,5}$")


def _normalize_proxy_token(token: str) -> str:
    """Satu token proxy -> URL standar, atau "" bila bukan proxy valid.

    Format host:port:user:pass dan user:pass@host:port (tanpa skema)
    dinormalisasi dulu ke URL standar.
    """
    proxy = (token or "").strip()
    if not proxy:
        return ""
    m = _PROXY_COLON_RE.match(proxy)
    if m:
        scheme = (m.group(1) or "http").lower()
        proxy = f"{scheme}://{m.group(4)}:{m.group(5)}@{m.group(2)}:{m.group(3)}"
        print("PROXY format host:port:user:pass dinormalisasi ke URL standar.")
    elif not _PROXY_RE.match(proxy) and _PROXY_BARE_AUTH_RE.match(proxy):
        proxy = "http://" + proxy
    if _PROXY_RE.match(proxy):
        return proxy
    print(f"PROXY diabaikan (format tidak dikenal): {proxy!r}", file=sys.stderr)
    return ""


MAX_PROXIES = 10


def _proxy_list() -> list[str]:
    """Daftar proxy dari env PROXY (diteruskan Worker; satu URL, atau
    bulk dipisah spasi / baris baru / koma). Tanpa proxy = [""].
    Duplikat dibuang, maks MAX_PROXIES — sisanya diabaikan."""
    raw = os.environ.get("PROXY", "").strip()
    if not raw:
        return [""]
    out: list[str] = []
    for tok in re.split(r"[\s,;]+", raw):
        norm = _normalize_proxy_token(tok)
        if norm and norm not in out:
            out.append(norm)
        if len(out) >= MAX_PROXIES:
            break
    return out or [""]


PROXY_LIST = _proxy_list()

# Cara yang dipakai run ini (diteruskan workflow dari input dispatch):
# USE_VPN=1 bila OpenVPN disambungkan sebelum probe/download,
# OVPN_CUSTOM=true bila config-nya custom dari user (bukan profile
# tersimpan). Dipakai run_probe untuk menyematkan cara yang sama ke
# tombol format, supaya klik format langsung download tanpa tanya lagi.
USE_VPN = os.environ.get("USE_VPN", "").strip() == "1"
OVPN_CUSTOM = os.environ.get("OVPN_CUSTOM", "").strip().lower() == "true"


def _reuse_suffix_for(base: str, proxy: str = "") -> str:
    """Akhiran tombol format yang membawa cara probe ("|n" / "|v" /
    "|p<proxy>") supaya download memakai cara yang sama. Kosong bila
    cara itu tidak bisa dibawa: config OpenVPN custom terlalu besar
    untuk callback Telegram (maks 64 byte), atau proxy terlalu panjang
    sehingga total callback melewati 64 byte. `proxy` = proxy yang
    BERHASIL saat probe (dari laporan rotasi), bukan sembarang daftar."""
    if USE_VPN and OVPN_CUSTOM:
        return ""
    if USE_VPN:
        suffix = "|v"
    elif proxy:
        suffix = f"|p{proxy}"
    else:
        suffix = "|n"
    return suffix if len(base) + len(suffix) <= 64 else ""


def _mask_proxy(proxy: str) -> str:
    """Tampilan aman proxy untuk laporan: skema://host (tanpa user:pass)."""
    if not proxy:
        return "tanpa proxy"
    try:
        from urllib.parse import urlparse
        u = urlparse(proxy)
        return f"{u.scheme}://{u.hostname}" if u.hostname else "(proxy)"
    except Exception:  # noqa: BLE001 - tampilan gagal tidak boleh menggagalkan laporan
        return "(proxy)"


# Error yang BUKAN salah proxy (video privat / dihapus / dibatasi usia):
# mencoba proxy lain tidak ada gunanya, jadi rotasi berhenti langsung.
_DEFINITIVE_ERR_MARKERS = (
    "private video", "video unavailable", "this video is unavailable",
    "no longer available", "has been removed", "removed by the uploader",
    "confirm your age", "age-gated", "copyright",
    "account has been terminated",
)


def _is_definitive_error(e: Exception) -> bool:
    s = str(e).lower()
    return any(m in s for m in _DEFINITIVE_ERR_MARKERS)


def _short_reason(e: Exception) -> str:
    """Alasan gagal yang singkat untuk laporan proxy."""
    s = str(e)
    if "Sign in to confirm" in s:
        return "diblokir YouTube (bot-check)"
    if any(m in s.lower() for m in _PROXY_ERR_MARKERS):
        return "proxy tidak bisa dihubungi"
    return (s[:80] + "…") if len(s) > 80 else s


class _AllProxiesFailed(Exception):
    """Semua proxy gagal; membawa laporan rotasi untuk pesan ke user."""
    def __init__(self, report: dict, last_error: Exception):
        super().__init__(str(last_error))
        self.report = report
        self.last_error = last_error


def _proxy_report_text(report: dict, *, what: str) -> str:
    """Laporan bulk proxy: berhasil / gagal (+alasan) / belum dicoba."""
    lines = [f"🔌 Laporan proxy ({what}):"]
    if report["used"]:
        lines.append(
            f"✅ Berhasil: {_mask_proxy(report['used'])} "
            f"(proxy ke-{report['used_index'] + 1} dari {report['total']})")
    for proxy, reason in report["failed"]:
        lines.append(f"❌ Gagal: {_mask_proxy(proxy)} — {escape_html(reason)}")
    if report["untried"]:
        lines.append("⏭️ Belum dicoba: " +
                     ", ".join(_mask_proxy(p) for p in report["untried"]))
    return "\n".join(lines)


def _rotate_proxies(fn, *, progress=None):
    """Coba fn(proxy) untuk tiap proxy di PROXY_LIST sampai berhasil.

    fn(proxy) mengembalikan hasil atau raise. Mengembalikan
    (hasil, report) dengan report = {"used", "used_index", "failed":
    [(proxy, alasan)], "untried": [...], "total": n}. Bila semua gagal,
    raise _AllProxiesFailed yang membawa report-nya. Error definitif
    (video privat/dihapus/dibatasi usia) menghentikan rotasi langsung,
    karena bukan salah proxy. progress(idx, total, proxy) dipanggil
    sebelum tiap percobaan bila proxy-nya lebih dari satu (untuk
    update pesan status di Telegram)."""
    failed: list[tuple[str, str]] = []
    for idx, proxy in enumerate(PROXY_LIST):
        if progress and len(PROXY_LIST) > 1:
            progress(idx, len(PROXY_LIST), proxy)
        try:
            result = fn(proxy)
        except Exception as e:  # noqa: BLE001 - putuskan: lanjut / berhenti
            if _is_definitive_error(e):
                raise
            failed.append((proxy, _short_reason(e)))
            print(f"Proxy {idx + 1}/{len(PROXY_LIST)} ({_mask_proxy(proxy)}) "
                  f"gagal: {e}", file=sys.stderr)
            continue
        return result, {
            "used": proxy, "used_index": idx,
            "failed": failed, "untried": PROXY_LIST[idx + 1:],
            "total": len(PROXY_LIST),
        }
    last = failed[-1][1] if failed else "gagal"
    raise _AllProxiesFailed(
        {"used": "", "used_index": None, "failed": failed,
         "untried": [], "total": len(PROXY_LIST)},
        RuntimeError(f"Semua {len(PROXY_LIST)} proxy gagal (terakhir: {last})"),
    )


def _attempt_extras() -> list[tuple[dict, str]]:
    """Daftar (extra_opts, label) sesuai ATTEMPT_PLAN & ketersediaan cookies."""
    cookies = _cookies_file()
    out: list[tuple[dict, str]] = []
    for clients, use_cookies, fetch_pot in ATTEMPT_PLAN:
        if use_cookies and not cookies:
            continue
        yt_args: dict = {}
        if clients:
            yt_args["player_client"] = clients
        if fetch_pot:
            yt_args["fetch_pot"] = ["always"]
        extra: dict = {}
        if yt_args:
            extra["extractor_args"] = {"youtube": yt_args}
        if use_cookies:
            extra["cookiefile"] = cookies
        label_parts = list(clients or ["default"])
        if use_cookies:
            label_parts.append("+cookies")
        if fetch_pot:
            label_parts.append("+pot")
        out.append((extra, ",".join(label_parts)))
    return out


# Penanda error koneksi PROXY (bukan error dari YouTube): proxy mati,
# port tutup, atau menolak koneksi. Client mana pun akan gagal dengan
# cara yang sama, jadi tangga percobaan dihentikan segera (fail-fast)
# dan user diberi tahu bahwa masalahnya di proxy.
_PROXY_ERR_MARKERS = (
    "connection refused", "failed to establish a new connection",
    "unable to connect to proxy", "proxyerror", "proxy error",
    "sockshttpsconnection", "sockshttpconnection",
    "connection to proxy closed",
)


def _is_proxy_conn_error(e: Exception, proxy: str = "") -> bool:
    if not proxy:
        return False
    s = str(e).lower()
    return any(m in s for m in _PROXY_ERR_MARKERS)


def _base_opts(proxy: str = "") -> dict:
    opts = {
        "quiet": True, "no_warnings": True, "noplaylist": True,
        "retries": 10, "fragment_retries": 10, "socket_timeout": 30,
        # GitHub runner punya node terpasang; yt-dlp default cuma mengaktifkan
        # deno, jadi aktifkan node agar tantangan JS YouTube bisa diselesaikan.
        "js_runtimes": {"node": {}},
        # Solver JS eksternal resmi yt-dlp: membuka daftar format client web
        # (web_safari, tv_samsung, dll) yang kosong tanpa komponen ini.
        "remote_components": ["ejs:github"],
    }
    if proxy:
        # Semua trafik yt-dlp (probe maupun download) lewat proxy ini.
        opts["proxy"] = proxy
    return opts


def _download_with_one_proxy(url: str, choice: dict, out_dir: Path,
                             proxy: str) -> tuple[Path, str]:
    base_opts = _base_opts(proxy)
    base_opts.update({
        "format": choice["format"],
        "outtmpl": str(out_dir / "%(title).80s.%(ext)s"),
    })
    if choice["kind"] == "audio":
        base_opts["postprocessors"] = [{
            "key": "FFmpegExtractAudio",
            "preferredcodec": choice.get("codec", "mp3"),
            "preferredquality": choice.get("quality", "192"),
        }]
    else:
        base_opts["merge_output_format"] = "mp4"

    attempts = _attempt_extras()
    last_error: Exception | None = None
    for i, (extra, label) in enumerate(attempts, 1):
        opts = {**base_opts, **extra}
        try:
            with yt_dlp.YoutubeDL(opts) as ydl:
                info = ydl.extract_info(url, download=True)
        except Exception as e:  # noqa: BLE001 - coba client berikutnya
            last_error = e
            print(f"Percobaan {i}/{len(attempts)} (client={label}) "
                  f"gagal: {e}", file=sys.stderr)
            if _is_proxy_conn_error(e, proxy):
                raise
            # Bersihkan hasil parsial attempt ini, TAPI simpan file .part:
            # attempt berikutnya bisa melanjutkannya (resume) alih-alih
            # mengulang dari nol — penting untuk file besar lewat
            # koneksi yang tidak stabil.
            for p in out_dir.glob("*"):
                if p.is_file() and ".part" not in p.name:
                    p.unlink()
            continue

        if info and "entries" in info:
            info = info["entries"][0]
        title = (info or {}).get("title") or "Video YouTube"
        candidates = [
            p for p in out_dir.glob("*")
            if p.is_file() and p.suffix.lower() in {".mp4", ".mkv", ".webm", ".mp3", ".m4a"}
            and ".part" not in p.name
        ]
        if not candidates:
            raise FileNotFoundError("File hasil download tidak ditemukan.")
        print(f"Berhasil dengan percobaan {i}/{len(attempts)} (client={label})")
        return max(candidates, key=lambda p: p.stat().st_size), title

    raise last_error or RuntimeError("Semua percobaan download gagal.")


def download_media(url: str, choice: dict, out_dir: Path, *,
                   on_proxy=None) -> tuple[tuple[Path, str], dict]:
    """Download memakai rotasi proxy; mengembalikan ((file, judul), report).
    on_proxy(idx, total, proxy) dipanggil sebelum tiap proxy dicoba."""
    return _rotate_proxies(
        lambda p: _download_with_one_proxy(url, choice, out_dir, p),
        progress=on_proxy,
    )


def _probe_with_one_proxy(url: str, proxy: str) -> dict:
    """Ekstrak info lengkap (tanpa download) memakai tangga client yang sama."""
    attempts = _attempt_extras()
    last_error: Exception | None = None
    for i, (extra, label) in enumerate(attempts, 1):
        opts = {**_base_opts(proxy), **extra}
        try:
            with yt_dlp.YoutubeDL(opts) as ydl:
                info = ydl.extract_info(url, download=False)
        except Exception as e:  # noqa: BLE001 - coba client berikutnya
            last_error = e
            print(f"Probe percobaan {i}/{len(attempts)} (client={label}) "
                  f"gagal: {e}", file=sys.stderr)
            if _is_proxy_conn_error(e, proxy):
                raise
            continue
        if info and "entries" in info:
            info = info["entries"][0]
        print(f"Probe berhasil dengan percobaan {i}/{len(attempts)} (client={label})")
        return info
    raise last_error or RuntimeError("Semua percobaan probe gagal.")


def extract_info_probe(url: str, *, on_proxy=None) -> tuple[dict, dict]:
    """Ekstrak info memakai rotasi proxy; mengembalikan (info, report).
    on_proxy(idx, total, proxy) dipanggil sebelum tiap proxy dicoba."""
    return _rotate_proxies(
        lambda p: _probe_with_one_proxy(url, p),
        progress=on_proxy,
    )


def _fmt_size_est(f: dict, duration: int) -> int:
    if f.get("filesize"):
        return int(f["filesize"])
    if f.get("filesize_approx"):
        return int(f["filesize_approx"])
    if f.get("tbr") and duration:
        return int(f["tbr"] * 1000 / 8 * duration)
    return 0


def _selected_size(formats: list[dict], fmt_string: str, duration: int) -> int:
    """Ukuran format yang AKAN dipilih yt-dlp untuk string format tertentu,
    dihitung dengan pemilih format yt-dlp sendiri atas daftar format probe."""
    try:
        with yt_dlp.YoutubeDL({"quiet": True, "no_warnings": True}) as ydl:
            selector = ydl.build_format_selector(fmt_string)
            picked = list(selector({"formats": formats, "incomplete_formats": False}))
        total = 0
        for p in picked:
            for r in (p.get("requested_formats") or [p]):
                total += _fmt_size_est(r, duration)
        return total
    except Exception as e:  # noqa: BLE001 - jatuh ke perkiraan manual
        print(f"build_format_selector gagal ({fmt_string}): {e}", file=sys.stderr)
        return 0


def _selected_fps(formats: list[dict], fmt_string: str) -> int:
    """FPS format video yang AKAN dipilih yt-dlp untuk string format ini
    (0 bila tidak diketahui), dengan pemilih format yang sama seperti
    _selected_size supaya angka di tombol sesuai yang akan diunduh."""
    try:
        with yt_dlp.YoutubeDL({"quiet": True, "no_warnings": True}) as ydl:
            selector = ydl.build_format_selector(fmt_string)
            picked = list(selector({"formats": formats, "incomplete_formats": False}))
        fps = 0
        for p in picked:
            for r in (p.get("requested_formats") or [p]):
                if (r.get("vcodec") or "none") != "none" and r.get("fps"):
                    fps = max(fps, r["fps"])
        return int(round(fps)) if fps else 0
    except Exception as e:  # noqa: BLE001
        print(f"build_format_selector (fps) gagal ({fmt_string}): {e}", file=sys.stderr)
        return 0


def compute_options(info: dict) -> dict:
    """Hitung resolusi yang tersedia (maks 4320p) + perkiraan ukuran tiap opsi."""
    formats = info.get("formats") or []
    duration = int(info.get("duration") or 0)

    heights = sorted(
        {int(f["height"]) for f in formats
         if f.get("height") and f.get("vcodec") not in (None, "none")},
        reverse=True,
    )
    heights = [h for h in heights if 144 <= h <= 4320]

    buckets: list[tuple[int, int, int]] = []
    for h in heights:
        choice = resolve_choice(f"v{h}")
        size = _selected_size(formats, choice["format"], duration) if choice else 0
        fps = _selected_fps(formats, choice["format"]) if choice else 0
        if size <= 0:
            # Cadangan manual: video mp4 tertinggi bitrate-nya pada tinggi ini
            # + audio m4a terbaik.
            vids = [f for f in formats
                    if f.get("height") == h and f.get("vcodec") not in (None, "none")
                    and f.get("acodec") in (None, "none")]
            auds = [f for f in formats
                    if f.get("vcodec") in (None, "none") and f.get("ext") == "m4a"]
            if vids:
                best_v = max(vids, key=lambda f: (f.get("ext") != "mp4", -(f.get("tbr") or 0)))
                size = _fmt_size_est(best_v, duration)
                if auds:
                    size += _fmt_size_est(max(auds, key=lambda f: f.get("tbr") or 0), duration)
                if not fps and best_v.get("fps"):
                    fps = int(round(best_v["fps"]))
        if size > 0:
            buckets.append((h, size, fps))

    m4a_choice = FORMAT_CHOICES["aud_m4a"]
    m4a_size = _selected_size(formats, m4a_choice["format"], duration)
    if m4a_size <= 0 and duration:
        m4a_size = int(duration * 128_000 / 8)
    mp3_size = int(duration * 192_000 / 8) if duration else 0

    return {
        "title": info.get("title") or "Video YouTube",
        "uploader": info.get("uploader") or info.get("channel") or "-",
        "duration": duration,
        "video_id": info.get("id") or "",
        "buckets": buckets,
        "mp3_size": mp3_size,
        "m4a_size": m4a_size,
    }


def run_probe(chat_id: str, url: str) -> int:
    placeholder_raw = os.environ.get("PROBE_MESSAGE_ID", "").strip()
    placeholder_id = int(placeholder_raw) if placeholder_raw.isdigit() else None

    def _on_proxy(idx: int, total: int, proxy: str) -> None:
        if placeholder_id:
            edit_text(chat_id, placeholder_id,
                      "🔍 Sedang memeriksa kualitas & ukuran yang tersedia...\n"
                      f"(proxy ke-{idx + 1} dari {total}: {_mask_proxy(proxy)})")

    try:
        info, proxy_report = extract_info_probe(url, on_proxy=_on_proxy)
        used_proxy = proxy_report["used"]
        opts = compute_options(info)
        if not opts["buckets"] and not opts["m4a_size"]:
            raise RuntimeError("Tidak ada format yang bisa diunduh dari video ini.")

        vid = opts["video_id"]

        def kb(choice: str) -> str:
            base = f"dl:{vid}:{choice}"
            if choice == "cancel":
                return base
            # Suffix membawa proxy yang BERHASIL saat probe, supaya
            # download langsung memakai proxy itu (bukan daftar bulk).
            return base + _reuse_suffix_for(base, used_proxy)

        rows: list[list[dict]] = []
        row: list[dict] = []
        for h, size, fps in opts["buckets"]:
            label = (f"🎬 {h}p • {fps}fps • ±{fmt_size(size)}" if fps
                     else f"🎬 {h}p • ±{fmt_size(size)}")
            row.append({"text": label,
                        "callback_data": kb(f"v{h}")})
            if len(row) == 2:
                rows.append(row)
                row = []
        if row:
            rows.append(row)
        audio_row = []
        if opts["mp3_size"]:
            audio_row.append({"text": f"🎵 MP3 • ±{fmt_size(opts['mp3_size'])}",
                              "callback_data": kb("aud_mp3")})
        if opts["m4a_size"]:
            audio_row.append({"text": f"🎵 M4A • ±{fmt_size(opts['m4a_size'])}",
                              "callback_data": kb("aud_m4a")})
        if audio_row:
            rows.append(audio_row)
        rows.append([{"text": "✖️ Batal", "callback_data": kb("cancel")}])

        caption = (
            f"<b>{escape_html(opts['title'])}</b>\n\n"
            f"👤 {escape_html(opts['uploader'])}\n"
            f"⏱ {fmt_duration(opts['duration'])}\n\n"
            "Pilih format yang mau didownload (ukuran perkiraan):"
        )
        big = [size for _, size, _fps in opts["buckets"] if size > MAX_SIZE_SAFE]
        if big and mtproto_ready():
            caption += "\nℹ️ Opsi di atas 50 MB dikirim lewat jalur file besar (maks 2 GB, lebih lambat)."
            if any(size > MAX_SIZE_MTPROTO for size in big):
                caption += "\n⚠️ Opsi di atas 2 GB tetap tidak bisa dikirim."
        elif big:
            caption += "\n⚠️ Opsi di atas 50 MB tidak bisa dikirim lewat Telegram."

        if placeholder_id:
            tg_post("deleteMessage", json={"chat_id": chat_id, "message_id": placeholder_id})
        photo = tg_post("sendPhoto", json={
            "chat_id": chat_id,
            "photo": f"https://i.ytimg.com/vi/{vid}/hqdefault.jpg",
            "caption": caption, "parse_mode": "HTML",
            "reply_markup": {"inline_keyboard": rows},
        })
        if not photo.get("ok"):
            tg_post("sendMessage", json={
                "chat_id": chat_id, "text": caption, "parse_mode": "HTML",
                "reply_markup": {"inline_keyboard": rows},
            })
        if len(PROXY_LIST) > 1:
            send_text(chat_id, _proxy_report_text(proxy_report, what="cek kualitas"))
        print(f"Probe terkirim: {len(opts['buckets'])} resolusi untuk chat {chat_id}")
        return 0
    except Exception as e:  # noqa: BLE001
        print(f"PROBE ERROR: {e}", file=sys.stderr)
        text = _user_error_text(e)
        report = getattr(e, "report", None)
        if report and len(PROXY_LIST) > 1:
            text += "\n\n" + _proxy_report_text(report, what="cek kualitas")
        kb = None
        m = _VIDEO_ID_RE.search(url)
        if m:
            kb = probe_choice_keyboard(m.group(1))
            text += "\n\nPilih cara lain untuk mencoba lagi:"
        if placeholder_id:
            edit_text(chat_id, placeholder_id, text, reply_markup=kb)
        else:
            send_text(chat_id, text, reply_markup=kb)
        return 1


def _user_error_text(e: Exception) -> str:
    # Bila error dibungkus _AllProxiesFailed, periksa error aslinya.
    inner = getattr(e, "last_error", None) or e
    if "Port could not be cast" in str(inner):
        return (
            "❌ Format proxy-nya tidak valid — bagian port terbaca bukan angka.\n\n"
            "Kirim proxy dalam format URL standar:\n"
            "<code>skema://user:pass@host:port</code>\n"
            "contoh: <code>http://user123:pass123@1.2.3.4:8080</code>\n"
            "Format host:port:user:pass dari penjual proxy juga diterima "
            "dan diubah otomatis. Coba lagi lewat tombol 🔌 di bawah."
        )
    if any(_is_proxy_conn_error(inner, p) for p in PROXY_LIST if p):
        return (
            "❌ Proxy-nya tidak bisa dipakai: koneksi ke proxy gagal / ditolak.\n\n"
            "Permintaan belum sempat sampai ke YouTube — proxy kemungkinan "
            "sudah mati, port-nya tutup, atau menolak koneksi. Proxy "
            "publik/gratis memang umurnya pendek dan gampang jebol saat "
            "dipakai download besar. Ganti proxy lain lewat tombol 🔌 "
            "di bawah, atau pilih download tanpa proxy."
        )
    if "Sign in to confirm" in str(inner):
        return (
            "❌ YouTube memblokir IP server GitHub Actions "
            "(bot-check: \"Sign in to confirm you're not a bot\") "
            "setelah semua client dicoba.\n\n"
            "Coba lagi dengan proxy / OpenVPN lewat tombol di bawah — "
            "IP runner berganti tiap run, sebagian tidak diblokir. "
            "Bila terus gagal, pemilik bot perlu memasang cookies "
            "YouTube (secret YOUTUBE_COOKIES)."
        )
    return (
        f"❌ Gagal memproses video ini.\n<code>{escape_html(str(e)[:250])}</code>\n\n"
        "Coba kualitas lain, atau cek apakah video privat / dibatasi usia."
    )


def main() -> int:
    chat_id = os.environ.get("CHAT_ID", "").strip()
    url = os.environ.get("YOUTUBE_URL", "").strip()
    mode = os.environ.get("MODE", "download").strip().lower()

    if not TOKEN:
        print("ERROR: secret TELEGRAM_BOT_TOKEN belum diset di repo.", file=sys.stderr)
        return 1
    if not chat_id or not url:
        print(f"ERROR: input tidak valid. chat_id={chat_id!r} url={url!r}", file=sys.stderr)
        return 1

    if mode == "probe":
        return run_probe(chat_id, url)

    choice_key = os.environ.get("FORMAT_CHOICE", "vid_720").strip()
    choice = resolve_choice(choice_key)
    if not choice:
        print(f"ERROR: FORMAT_CHOICE tidak dikenal: {choice_key!r}", file=sys.stderr)
        return 1

    status_id = send_text(chat_id, f"⬇️ Mengunduh {choice['label']}...\nProses di GitHub Actions, mohon tunggu.")
    work = Path(tempfile.mkdtemp(prefix="yt-"))

    def _on_proxy(idx: int, total: int, proxy: str) -> None:
        if status_id:
            edit_text(chat_id, status_id,
                      f"⬇️ Mengunduh {choice['label']}...\n(proxy ke-{idx + 1} dari {total}: {_mask_proxy(proxy)})")

    try:
        (file_path, title), proxy_report = download_media(url, choice, work, on_proxy=_on_proxy)
        size = file_path.stat().st_size
        if size > MAX_SIZE_MTPROTO:
            edit_text(chat_id, status_id,
                      f"⚠️ Hasilnya terlalu besar bahkan untuk Telegram.\n\n"
                      f"📦 Ukuran: <b>{fmt_size(size)}</b> (maks 2 GB)\n{escape_html(title)}\n\n"
                      "Coba kualitas lebih rendah (480p/360p) atau audio MP3/M4A.")
            return 0
        if size > MAX_SIZE_SAFE and not mtproto_ready():
            edit_text(chat_id, status_id,
                      f"⚠️ Hasilnya terlalu besar untuk bot Telegram.\n\n"
                      f"📦 Ukuran: <b>{fmt_size(size)}</b> (maks 50 MB)\n{escape_html(title)}\n\n"
                      "Coba kualitas lebih rendah (480p/360p) atau audio MP3/M4A.")
            return 0

        # Download selesai — putuskan VPN (bila run ini memakainya) agar
        # upload ke Telegram lewat IP asli runner, bukan tunnel VPN.
        drop_vpn_before_upload()

        caption = f"<b>{escape_html(title)}</b>\n{choice['label']} • {fmt_size(size)}"
        if size > MAX_SIZE_SAFE:
            # Jalur MTProto untuk file besar (50 MB - 2 GB): login bot
            # via Telethon, tetap dengan thumbnail + atribut video.
            edit_text(chat_id, status_id,
                      f"⬆️ Mengunggah file besar ke Telegram... ({fmt_size(size)})\n"
                      "Jalur ini lebih lambat, bisa beberapa menit. Mohon tunggu.")
            meta = probe_video_metadata(file_path)
            thumb = (make_thumbnail(file_path, meta["duration"], work)
                     if choice["kind"] == "video" else None)
            send_large(chat_id, file_path, caption, choice["kind"], meta, thumb)
            if status_id:
                tg_post("deleteMessage", json={"chat_id": chat_id, "message_id": status_id})
            if len(PROXY_LIST) > 1:
                send_text(chat_id, _proxy_report_text(proxy_report, what="download"))
            print(f"OK (MTProto): terkirim {file_path.name} ({fmt_size(size)}) ke chat {chat_id}")
            return 0

        edit_text(chat_id, status_id, f"⬆️ Mengunggah ke Telegram... ({fmt_size(size)})")
        method = "sendAudio" if choice["kind"] == "audio" else "sendVideo"
        field = "audio" if choice["kind"] == "audio" else "video"
        thumb_fh = None
        with open(file_path, "rb") as fh:
            data = {"chat_id": chat_id, "caption": caption, "parse_mode": "HTML"}
            files = {field: (file_path.name, fh)}
            if method == "sendVideo":
                data["supports_streaming"] = "true"
                # Atribut eksplisit agar durasi tidak tampil 0:00 di HP
                # dan pratinjau video tidak kosong.
                meta = probe_video_metadata(file_path)
                if meta["duration"]:
                    data["duration"] = str(meta["duration"])
                if meta["width"] and meta["height"]:
                    data["width"] = str(meta["width"])
                    data["height"] = str(meta["height"])
                thumb = make_thumbnail(file_path, meta["duration"], work)
                if thumb:
                    thumb_fh = open(thumb, "rb")
                    files["thumbnail"] = (thumb.name, thumb_fh)
            try:
                r = requests.post(f"{API}/{method}", data=data,
                                  files=files, timeout=600)
            finally:
                if thumb_fh:
                    thumb_fh.close()
        result = r.json()
        if not result.get("ok"):
            edit_text(chat_id, status_id, f"❌ Upload ke Telegram gagal: {escape_html(str(result)[:250])}")
            return 1

        if status_id:
            tg_post("deleteMessage", json={"chat_id": chat_id, "message_id": status_id})
        if len(PROXY_LIST) > 1:
            send_text(chat_id, _proxy_report_text(proxy_report, what="download"))
        print(f"OK: terkirim {file_path.name} ({fmt_size(size)}) ke chat {chat_id}")
        return 0
    except Exception as e:  # noqa: BLE001
        print(f"ERROR: {e}", file=sys.stderr)
        text = _user_error_text(e)
        report = getattr(e, "report", None)
        if report and len(PROXY_LIST) > 1:
            text += "\n\n" + _proxy_report_text(report, what="download")
        kb = None
        m = _VIDEO_ID_RE.search(url)
        if m:
            kb = download_choice_keyboard(m.group(1), choice_key)
            text += "\n\nPilih cara lain untuk mencoba lagi:"
        edit_text(chat_id, status_id, text, reply_markup=kb)
        return 1
    finally:
        shutil.rmtree(work, ignore_errors=True)


if __name__ == "__main__":
    raise SystemExit(main())
