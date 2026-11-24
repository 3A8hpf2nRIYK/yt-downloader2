/**
 * YouTube Telegram Bot — Cloudflare Worker (webhook handler)
 * ===========================================================
 * Tugas Worker ini HANYA:
 *   1. Terima webhook Telegram
 *   2. Saat user mengirim link: kirim pesan placeholder, lalu trigger
 *      GitHub Actions mode "probe" — probe mengekstrak format yang
 *      benar-benar tersedia (s/d 8K) + perkiraan ukurannya, lalu mengirim
 *      foto + tombol format dinamis ke chat. Probe selalu TANPA proxy.
 *   3. Saat tombol resolusi diklik, user memilih cara download lewat
 *      5 tombol + batal: tanpa proxy / proxy custom / profile OpenVPN
 *      tersimpan / custom config OpenVPN / batal. "Tanpa proxy"
 *      langsung trigger mode "download"; "proxy custom" membalas user
 *      dengan pesan perintah (force reply) yang membawa kode tugas
 *      "px:<videoId>:<choice>" — user membalasnya dengan URL proxy,
 *      lalu download ditrigger memakai proxy itu. "Profile tersimpan"
 *      mentrigger download dengan input use_vpn=1 (workflow
 *      menyambungkan VPN dari secret OPENVPN_CONFIG). "Custom config"
 *      meminta user membalas prompt dengan file .ovpn, tempelan teks
 *      config, atau link raw config (Worker mengambilnya dari link
 *      itu); bila config butuh login (ada baris auth-user-pass), bot
 *      meminta username + password dalam satu balasan lagi — prompt
 *      kedua membawa serta config-nya karena Worker tidak punya
 *      penyimpanan: file_id untuk config berkas
 *      (ovpnfile:<file_id>), atau isi config tersemat di antara
 *      penanda ovpncfg:begin/ovpncfg:end untuk config teks/link yang
 *      cukup pendek. Config lalu diteruskan ke workflow sebagai
 *      input ovpn_config. Pilihan yang sama juga muncul di
 *      pesan gagal dari downloader, jadi user bisa langsung mencoba
 *      cara lain tanpa mengulang dari awal.
 *
 * Download TIDAK dilakukan di Worker: Workers tidak bisa menjalankan
 * yt-dlp / ffmpeg, tidak punya filesystem, dan memori cuma 128 MB.
 *
 * Secrets / Vars yang dibutuhkan (set di Cloudflare Dashboard atau
 * pakai `wrangler secret put <NAMA>`):
 *   TELEGRAM_BOT_TOKEN       (secret, wajib) token dari @BotFather
 *   TELEGRAM_WEBHOOK_SECRET  (secret, wajib) string acak bebas, dipakai
 *                            Telegram untuk menandai webhook asli
 *   GITHUB_TOKEN             (secret, wajib) PAT dengan izin Actions: write
 *                            pada repo ini saja (fine-grained disarankan)
 *   GITHUB_OWNER             (var, wajib) username / org GitHub
 *   GITHUB_REPO              (var, wajib) nama repo ini
 *   GITHUB_REF               (var, opsional) default "main"
 *   ALLOWED_USER_IDS         (var, opsional) pisah koma, kosong = semua boleh
 */

const CHOICES = {
  vid_best: "🎬 Video - Terbaik",
  vid_1080: "🎬 Video - 1080p",
  vid_720: "🎬 Video - 720p",
  vid_480: "🎬 Video - 480p",
  vid_360: "🎬 Video - 360p",
  aud_mp3: "🎵 Audio - MP3",
  aud_m4a: "🎵 Audio - M4A",
};

// Pilihan dinamis dari probe: "v<tinggi>" (mis. v4320, v2160, v1080)
const DYNAMIC_CHOICE_RE = /^v(\d{3,4})$/;

function choiceLabel(choice) {
  if (CHOICES[choice]) return CHOICES[choice];
  const m = String(choice).match(DYNAMIC_CHOICE_RE);
  if (m) return `🎬 Video - ${m[1]}p`;
  return null;
}

// ---------------------------------------------------------------- util
// Proxy untuk yt-dlp: skema yang didukung http, https, socks4, socks4a,
// socks5, socks5h. Format: skema://[user:pass@]host:port
const PROXY_URL_RE = /^(https?|socks4a?|socks5h?):\/\/\S+$/i;

// Format 4-bagian dari banyak penjual proxy: host:port:user:pass (kadang
// ditempel skema di depannya). Bentuk ini WAJIB diubah ke URL standar
// http://user:pass@host:port — kalau dibiarkan, potongan terakhir
// (password) terbaca sebagai port dan semua percobaan download gagal
// seketika ("Port could not be cast to integer", kejadian live
// 2026-11-22 run 45018945676).
const PROXY_COLON_RE = /^(?:(https?|socks4a?|socks5h?):\/\/)?([\w.-]+):(\d{1,5}):([^\s:@/]+):([^\s:@/]+)$/i;
const PROXY_BARE_AUTH_RE = /^[^\s:@/]+:[^\s:@/]+@[\w.-]+:\d{1,5}$/;
function normalizeProxyToken(w) {
  const m = PROXY_COLON_RE.exec(w);
  if (m) return `${(m[1] || "http").toLowerCase()}://${m[4]}:${m[5]}@${m[2]}:${m[3]}`;
  if (PROXY_URL_RE.test(w)) return w;
  if (PROXY_BARE_AUTH_RE.test(w)) return `http://${w}`;
  return "";
}

// Tampilan aman: buang user:pass@ dari URL proxy.
function maskProxy(proxy) {
  try {
    const u = new URL(proxy);
    return `${u.protocol}//${u.host}`;
  } catch {
    return "(proxy)";
  }
}

export function extractVideoId(text) {
  if (!text) return null;
  const patterns = [
    /(?:youtube\.com\/(?:watch\?[^ \n]*v=|shorts\/|live\/|embed\/))([\w-]{11})/i,
    /(?:youtu\.be\/)([\w-]{11})/i,
    /(?:music\.youtube\.com\/watch\?[^ \n]*v=)([\w-]{11})/i,
  ];
  for (const re of patterns) {
    const m = String(text).match(re);
    if (m) return m[1];
  }
  return null;
}

function isAllowed(env, userId) {
  const raw = (env.ALLOWED_USER_IDS || "").trim();
  if (!raw) return true;
  return raw.split(",").map((s) => s.trim()).includes(String(userId));
}

function escapeHtml(s) {
  return String(s || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

async function tg(env, method, payload) {
  const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = await res.json().catch(() => ({}));
  if (!data.ok) console.error("Telegram API error", method, JSON.stringify(data));
  return data;
}

// Unduh isi file Telegram (mis. dokumen .ovpn) sebagai teks.
async function tgFileText(env, fileId) {
  const info = await tg(env, "getFile", { file_id: fileId });
  const path = info?.result?.file_path;
  if (!path) return null;
  const res = await fetch(`https://api.telegram.org/file/bot${env.TELEGRAM_BOT_TOKEN}/${path}`);
  if (!res.ok) return null;
  return await res.text();
}

// Config OpenVPN minimal punya baris "remote <host>" dan "dev tun|tap",
// plus direktif "client" — yang pada config SoftEther/VPNGate bisa
// berada di tengah baris gabungan ("..., persist-tun, client, ..."),
// jadi kata "client" tidak diwajibkan di awal baris.
function looksLikeOvpn(text) {
  return !!text && /\bclient\b/.test(text) && /^\s*remote\s+\S+/m.test(text) && /^\s*dev\s+(tun|tap)\d*\b/m.test(text);
}

// Config butuh username/password bila ada baris auth-user-pass.
function ovpnNeedsAuth(text) {
  return /^\s*auth-user-pass\b/m.test(text || "");
}

// Ambil config .ovpn dari link raw yang dikirim user. Dibatasi 100 KB
// dan 20 detik; hanya isi teksnya yang dikembalikan.
async function fetchOvpnFromUrl(url) {
  try {
    const res = await fetch(url, {
      headers: { "user-agent": "Mozilla/5.0 (yt-downloader-bot)" },
      redirect: "follow",
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) return null;
    const len = Number(res.headers.get("content-length") || 0);
    if (len > 100000) return null;
    const text = await res.text();
    if (!text || text.length > 100000) return null;
    return text;
  } catch {
    return null;
  }
}

async function triggerGithubActions(env, { chatId, videoId, choice, mode = "download", probeMessageId = "", proxy = "", proxyCustom = false, useVpn = false, ovpnConfig = "", ovpnUser = "", ovpnPass = "" }) {
  const owner = env.GITHUB_OWNER;
  const repo = env.GITHUB_REPO;
  const ref = env.GITHUB_REF || "main";
  const apiUrl = `https://api.github.com/repos/${owner}/${repo}/actions/workflows/download.yml/dispatches`;
  const res = await fetch(apiUrl, {
    method: "POST",
    headers: {
      authorization: `Bearer ${env.GITHUB_TOKEN}`,
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      "user-agent": "yt-bot-cloudflare-worker",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      ref,
      inputs: {
        chat_id: String(chatId),
        youtube_url: `https://www.youtube.com/watch?v=${videoId}`,
        format_choice: choice,
        mode,
        probe_message_id: String(probeMessageId || ""),
        proxy: String(proxy || ""),
        proxy_custom: proxyCustom ? "1" : "",
        use_vpn: useVpn ? "1" : "",
        ovpn_config: String(ovpnConfig || ""),
        ovpn_user: String(ovpnUser || ""),
        ovpn_pass: String(ovpnPass || ""),
      },
    }),
  });
  // Sukses workflow_dispatch = HTTP 204 No Content
  return { ok: res.status === 204, status: res.status, body: await res.text().catch(() => "") };
}

// ------------------------------------------------------- cara download
// Keyboard 6 pilihan cara download untuk satu tugas (videoId + choice).
// Dipakai di pesan pilihan setelah resolusi diklik; downloader juga
// memasang tombol yang sama (callback_data identik) di pesan gagal.
function downloadChoiceKeyboard(videoId, choice) {
  return {
    inline_keyboard: [
      [{ text: "⬇️ Download tanpa proxy", callback_data: `px:${videoId}:${choice}:n` }],
      [{ text: "🔌 Download menggunakan proxy custom", callback_data: `px:${videoId}:${choice}:c` }],
      [{ text: "🛡️ Gunakan profile OpenVPN yang tersimpan", callback_data: `px:${videoId}:${choice}:v` }],
      [{ text: "📄 Gunakan custom config OpenVPN", callback_data: `px:${videoId}:${choice}:o` }],
      [{ text: "🌐 Download config OpenVPN dari link", callback_data: `px:${videoId}:${choice}:l` }],
      [{ text: "✖️ Batalkan / Cancel tugas", callback_data: `px:${videoId}:${choice}:x` }],
    ],
  };
}

async function clearKeyboard(env, chatId, messageId) {
  if (!messageId) return;
  await tg(env, "editMessageReplyMarkup", {
    chat_id: chatId, message_id: messageId, reply_markup: { inline_keyboard: [] },
  }).catch(() => {});
}

// Trigger mode download + kirim pesan "sedang diproses".
// ovpn (opsional) = { config, user, pass } config OpenVPN custom dari
// user; tanpa ovpn tapi useVpn true = pakai profile secret repo.
async function startDownload(env, { chatId, videoId, choice, proxy = "", useVpn = false, ovpn = null }) {
  const label = choiceLabel(choice) || choice;
  const result = await triggerGithubActions(env, {
    chatId, videoId, choice, proxy, proxyCustom: !!proxy, useVpn,
    ovpnConfig: ovpn?.config || "", ovpnUser: ovpn?.user || "", ovpnPass: ovpn?.pass || "",
  });
  if (result.ok) {
    await tg(env, "sendMessage", {
      chat_id: chatId,
      parse_mode: "HTML",
      text:
        `⏳ <b>${label}</b> sedang diproses di GitHub Actions.\n` +
        "File akan dikirim ke chat ini setelah selesai (biasanya 1-3 menit). Mohon tunggu, jangan spam ya." +
        (proxy ? `\n🔌 Proxy: ${maskProxy(proxy)}` : "") +
        (useVpn && ovpn ? "\n🛡️ VPN: OpenVPN (custom config)" : "") +
        (useVpn && !ovpn ? "\n🛡️ VPN: OpenVPN (profile tersimpan)" : ""),
    });
  } else {
    console.error("GitHub dispatch gagal", result.status, result.body);
    await tg(env, "sendMessage", {
      chat_id: chatId,
      text:
        `❌ Gagal memulai download di GitHub Actions (HTTP ${result.status}).\n` +
        "Cek: GITHUB_TOKEN masih berlaku? Nama repo di GITHUB_OWNER/GITHUB_REPO sudah benar? " +
        "Workflow download.yml sudah ada di branch main?",
    });
  }
  return result.ok;
}

// ---------------------------------------------------------------- handlers
async function handleMessage(env, message) {
  const chatId = message.chat.id;
  const userId = message.from?.id;
  const text = message.text || "";

  if (!isAllowed(env, userId)) {
    await tg(env, "sendMessage", { chat_id: chatId, text: "⛔ Kamu tidak punya akses ke bot ini." });
    return;
  }

  // Balasan berisi URL proxy untuk tugas yang menunggu: user memilih
  // "proxy custom", bot mengirim pesan perintah berkode tugas
  // "px:<videoId>:<choice>", dan balasan user ke pesan itulah yang
  // membawa proxy-nya (Worker tidak punya penyimpanan antar-request,
  // jadi kode tugas dibaca dari pesan yang dibalas).
  const replied = message.reply_to_message;
  if (replied && replied.from?.is_bot) {
    const token = String(replied.text || replied.caption || "")
      .match(/px:([\w-]{11}):([a-z0-9_]+)/);
    if (token && choiceLabel(token[2])) {
      const [, pendingVideoId, pendingChoice] = token;
      const repliedText = String(replied.text || replied.caption || "");
      const pendingLabel = choiceLabel(pendingChoice) || pendingChoice;

      // Langkah kredensial config OpenVPN custom: prompt kedua membawa
      // config-nya serta — "ovpnfile:<file_id>" untuk config berkas
      // (isi config tetap di Telegram), "ovpnurl:<url>" untuk config
      // dari link (config diambil ulang dari URL-nya), atau isi config
      // tersemat di antara penanda ovpncfg:begin/ovpncfg:end untuk
      // config teks. Worker tidak menyimpan apa pun. Balasan user =
      // username dan password (dua baris, atau satu baris dipisah spasi).
      const fileToken = repliedText.match(/ovpnfile:(\S+)/);
      const urlToken = repliedText.match(/ovpnurl:(\S+)/);
      const embedMatch = repliedText.match(/ovpncfg:begin\n([\s\S]*?)\novpncfg:end/);
      if (fileToken || urlToken || embedMatch) {
        const lines = String(text).split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
        let user = "", pass = "";
        if (lines.length >= 2) { [user, pass] = lines; }
        else if (lines.length === 1) {
          const sp = lines[0].indexOf(" ");
          if (sp > 0) { user = lines[0].slice(0, sp); pass = lines[0].slice(sp + 1).trim(); }
        }
        if (!user || !pass) {
          await tg(env, "sendMessage", {
            chat_id: chatId,
            text:
              "❌ Format kredensialnya belum pas. Balas pesan perintah tadi " +
              "dengan username di baris pertama dan password di baris kedua.",
          });
          return;
        }
        let cfg = embedMatch ? embedMatch[1] : null;
        if (!cfg && fileToken) cfg = await tgFileText(env, fileToken[1]);
        if (!cfg && urlToken) cfg = await fetchOvpnFromUrl(urlToken[1]);
        if (!cfg || !looksLikeOvpn(cfg) || cfg.length > 60000) {
          await tg(env, "sendMessage", {
            chat_id: chatId,
            text: "❌ Config OpenVPN-nya tidak bisa dibaca lagi. Ulangi dari pilihan resolusi ya.",
          });
          return;
        }
        if (replied.message_id) {
          await tg(env, "editMessageText", {
            chat_id: chatId, message_id: replied.message_id,
            text: "✅ Kredensial diterima. Download dimulai...",
          }).catch(() => {});
        }
        await startDownload(env, {
          chatId, videoId: pendingVideoId, choice: pendingChoice,
          useVpn: true, ovpn: { config: cfg, user, pass },
        });
        return;
      }

      // Pengirim prompt kredensial: pesan force-reply yang membawa
      // kode tugas + penanda pembawa config (file_id / URL / embed).
      const sendCredPrompt = async (carry) => {
        await tg(env, "sendMessage", {
          chat_id: chatId,
          parse_mode: "HTML",
          text:
            `🔐 <b>Config ini butuh login OpenVPN</b> — ${pendingLabel}\n\n` +
            "Balas (reply) pesan ini dengan username dan password-nya:\n" +
            "baris pertama = username\nbaris kedua = password\n\n" +
            carry,
          reply_markup: { force_reply: true, input_field_placeholder: "username, lalu password di baris baru" },
        });
      };

      // Teruskan config OpenVPN custom yang sudah diperoleh (dari
      // file / teks / link): cek ukuran; bila butuh login, kirim
      // prompt kredensial yang membawa serta config-nya; bila tidak,
      // langsung dispatch.
      const dispatchOvpnConfig = async (cfg, { fileId = "", sourceUrl = "" } = {}) => {
        if (cfg.length > 60000) {
          await tg(env, "sendMessage", {
            chat_id: chatId,
            text:
              "❌ Config-nya terlalu besar untuk diteruskan lewat jalur " +
              "custom. Simpan sebagai profile tersimpan saja ya (secret " +
              "OPENVPN_CONFIG di repo).",
          });
          return;
        }
        if (ovpnNeedsAuth(cfg)) {
          if (fileId) {
            await sendCredPrompt(`<code>px:${pendingVideoId}:${pendingChoice}\novpnfile:${fileId}</code>`);
          } else if (sourceUrl) {
            await sendCredPrompt(`<code>px:${pendingVideoId}:${pendingChoice}\novpnurl:${escapeHtml(sourceUrl)}</code>`);
          } else if (cfg.length <= 3500) {
            // Config teks: sematkan isinya di prompt kredensial
            // (diapit penanda ovpncfg) karena tidak ada file_id/URL.
            await sendCredPrompt(
              `<code>px:${pendingVideoId}:${pendingChoice}</code>\n` +
              "ovpncfg:begin\n" +
              `<code>${escapeHtml(cfg)}</code>\n` +
              "ovpncfg:end");
          } else {
            await tg(env, "sendMessage", {
              chat_id: chatId,
              text:
                "❌ Config ini butuh username/password dan terlalu panjang " +
                "untuk diteruskan dari teks. Kirim config-nya sebagai file " +
                ".ovpn (dokumen) ya, supaya bisa lanjut ke langkah login.",
            });
          }
          return;
        }
        if (replied.message_id) {
          await tg(env, "editMessageText", {
            chat_id: chatId, message_id: replied.message_id,
            text: "✅ Config diterima. Download dimulai...",
          }).catch(() => {});
        }
        await startDownload(env, {
          chatId, videoId: pendingVideoId, choice: pendingChoice,
          useVpn: true, ovpn: { config: cfg },
        });
      };

      // Langkah link config OpenVPN: prompt bertanda "ovpn:link".
      // Balasan user = URL download config (mis. link VPNGate); Worker
      // mengambil config-nya dari link itu.
      if (repliedText.includes("ovpn:link")) {
        const urlTok = String(text).split(/\s+/)
          .find((w) => /^https?:\/\/\S+$/i.test(w) && !/(?:youtube\.com|youtu\.be)/i.test(w)) || "";
        if (!urlTok) {
          await tg(env, "sendMessage", {
            chat_id: chatId,
            text: "❌ Itu bukan URL yang valid. Balas pesan perintah tadi dengan link download config-nya saja.",
          });
          return;
        }
        const cfg = await fetchOvpnFromUrl(urlTok);
        if (!cfg || !looksLikeOvpn(cfg)) {
          await tg(env, "sendMessage", {
            chat_id: chatId,
            text:
              "❌ Config dari link itu tidak bisa diambil atau bukan config " +
              "OpenVPN yang valid. Link unduhan seperti VPNGate cepat " +
              "kedaluwarsa — buat link baru lalu coba lagi, atau pakai opsi " +
              "custom config (file/teks).",
          });
          return;
        }
        await dispatchOvpnConfig(cfg, { sourceUrl: urlTok });
        return;
      }

      // Langkah config OpenVPN custom: prompt bertanda "ovpn:cfg".
      // Balasan user bisa berupa file .ovpn (dokumen), tempelan teks
      // config, atau link raw config (diambil Worker dari link itu).
      if (repliedText.includes("ovpn:cfg")) {
        let cfg = null, fileId = "", sourceUrl = "";
        if (message.document?.file_id) {
          fileId = message.document.file_id;
          cfg = await tgFileText(env, fileId);
        } else {
          const urlTok = String(text).split(/\s+/)
            .find((w) => /^https?:\/\/\S+$/i.test(w) && !/(?:youtube\.com|youtu\.be)/i.test(w)) || "";
          if (urlTok) {
            sourceUrl = urlTok;
            cfg = await fetchOvpnFromUrl(urlTok);
            if (!cfg) {
              await tg(env, "sendMessage", {
                chat_id: chatId,
                text:
                  "❌ Config dari link itu tidak bisa diambil (link mati, " +
                  "bukan teks mentah, atau terlalu besar). Coba kirim file " +
                  ".ovpn-nya langsung atau tempel isi config-nya ya.",
              });
              return;
            }
          } else if (looksLikeOvpn(text)) {
            cfg = text;
          }
        }
        if (!cfg || !looksLikeOvpn(cfg)) {
          await tg(env, "sendMessage", {
            chat_id: chatId,
            text:
              "❌ Itu bukan config OpenVPN yang valid. Balas pesan perintah " +
              "tadi dengan file .ovpn (dokumen), tempelan isi config-nya, " +
              "atau link raw config-nya.",
          });
          return;
        }
        await dispatchOvpnConfig(cfg, { fileId, sourceUrl });
        return;
      }

      const candidate = String(text).split(/\s+/)
        .map((w) => normalizeProxyToken(w))
        .find((w) => w && !/(?:youtube\.com|youtu\.be)/i.test(w)) || "";
      if (!candidate) {
        await tg(env, "sendMessage", {
          chat_id: chatId,
          text:
            "❌ Itu bukan proxy yang valid. Balas pesan perintah tadi " +
            "dengan proxy-nya saja, contoh:\nsocks5://user:pass@host:port\n" +
            "atau format host:port:user:pass dari penjual proxy.",
        });
        return;
      }
      if (replied.message_id) {
        await tg(env, "editMessageText", {
          chat_id: chatId, message_id: replied.message_id,
          text: `✅ Proxy diterima (${maskProxy(candidate)}). Download dimulai...`,
        }).catch(() => {});
      }
      await startDownload(env, {
        chatId, videoId: pendingVideoId, choice: pendingChoice, proxy: candidate,
      });
      return;
    }
  }

  if (text.startsWith("/start") || text.startsWith("/help")) {
    await tg(env, "sendMessage", {
      chat_id: chatId,
      parse_mode: "HTML",
      text:
        "👋 <b>YouTube Downloader Bot</b>\n\n" +
        "Kirimkan link YouTube, nanti aku cek dulu kualitas yang tersedia " +
        "(sampai 8K bila ada) lengkap dengan perkiraan ukurannya:\n" +
        "🎬 <b>Video</b> — sesuai resolusi asli video\n" +
        "🎵 <b>Audio</b> — MP3 / M4A\n\n" +
        "Setelah kamu klik resolusi, pilih cara download-nya:\n" +
        "⬇️ <b>Download tanpa proxy</b> — langsung diproses\n" +
        "🔌 <b>Download menggunakan proxy custom</b> — kamu akan diminta " +
        "mengirim URL proxy, lalu download memakai proxy itu\n" +
        "🛡️ <b>Gunakan profile OpenVPN yang tersimpan</b> — download " +
        "lewat VPN dari config .ovpn di secret repo\n" +
        "📄 <b>Gunakan custom config OpenVPN</b> — kamu mengirim config " +
        ".ovpn sendiri (file, tempelan teks, atau link raw); bila butuh " +
        "login, bot akan meminta username &amp; password-nya\n" +
        "🌐 <b>Download config OpenVPN dari link</b> — kamu mengirim " +
        "link unduhan config-nya (mis. VPNGate), bot yang mengambil " +
        "config-nya\n" +
        "✖️ <b>Batalkan / Cancel tugas</b> — batalkan tugas\n\n" +
        "Bila download gagal, keenam pilihan itu muncul lagi di pesan " +
        "gagalnya, jadi bisa langsung mencoba cara lain.\n\n" +
        "⚠️ Pengecekan &amp; download dijalankan di GitHub Actions, jadi " +
        "masing-masing butuh sekitar 1-3 menit. File s/d 50 MB dikirim " +
        "biasa; di atas itu lewat jalur file besar (maks 2 GB) bila aktif.",
    });
    return;
  }

  const videoId = extractVideoId(text);
  if (!videoId) {
    await tg(env, "sendMessage", {
      chat_id: chatId,
      text: "Itu bukan link YouTube yang valid. Kirim link seperti:\nhttps://www.youtube.com/watch?v=... atau https://youtu.be/...",
    });
    return;
  }

  // Placeholder dulu, lalu probe di GitHub Actions yang menggantinya dengan
  // foto + tombol format dinamis (resolusi tersedia + perkiraan ukuran).
  // Probe selalu berjalan TANPA proxy.
  const placeholder = await tg(env, "sendMessage", {
    chat_id: chatId,
    text: "🔍 Sedang memeriksa kualitas & ukuran yang tersedia...\n(sekitar 1 menit, prosesnya di GitHub Actions)",
  });
  const probeMessageId = placeholder?.result?.message_id || "";

  const result = await triggerGithubActions(env, {
    chatId, videoId, choice: "probe", mode: "probe", probeMessageId,
  });
  if (!result.ok) {
    console.error("GitHub dispatch probe gagal", result.status, result.body);
    const errText =
      `❌ Gagal memulai pengecekan di GitHub Actions (HTTP ${result.status}).\n` +
      "Cek: GITHUB_TOKEN masih berlaku? Nama repo di GITHUB_OWNER/GITHUB_REPO sudah benar? " +
      "Workflow download.yml sudah ada di branch main?";
    if (probeMessageId) {
      await tg(env, "editMessageText", { chat_id: chatId, message_id: probeMessageId, text: errText }).catch(() => {});
    } else {
      await tg(env, "sendMessage", { chat_id: chatId, text: errText });
    }
  }
}

async function handleCallback(env, query) {
  const data = query.data || "";
  const chatId = query.message?.chat?.id;
  const messageId = query.message?.message_id;
  if (!chatId) return;

  if (!isAllowed(env, query.from?.id)) {
    await tg(env, "answerCallbackQuery", { callback_query_id: query.id, text: "⛔ Tidak punya akses.", show_alert: true });
    return;
  }

  const parts = data.split(":");

  // Menu cara download: px:<videoId>:<choice>:<n|c|v|o|l|x>
  // (n = tanpa proxy, c = proxy custom, v = profile OpenVPN tersimpan,
  //  o = custom config OpenVPN, l = config OpenVPN dari link,
  //  x = batalkan)
  if (parts.length === 4 && parts[0] === "px") {
    const [, videoId, choice, action] = parts;
    const label = choiceLabel(choice);
    if (!label) return;

    if (action === "x") {
      await tg(env, "answerCallbackQuery", { callback_query_id: query.id, text: "Dibatalkan." });
      await clearKeyboard(env, chatId, messageId);
      if (messageId) {
        await tg(env, "editMessageText", {
          chat_id: chatId, message_id: messageId, text: "✖️ Tugas dibatalkan.",
        }).catch(() => {});
      }
      return;
    }

    if (action === "n") {
      await tg(env, "answerCallbackQuery", { callback_query_id: query.id, text: `${label} — tanpa proxy, diproses...` });
      await clearKeyboard(env, chatId, messageId);
      await startDownload(env, { chatId, videoId, choice, proxy: "" });
      return;
    }

    if (action === "v") {
      await tg(env, "answerCallbackQuery", { callback_query_id: query.id, text: `${label} — profile OpenVPN tersimpan, diproses...` });
      await clearKeyboard(env, chatId, messageId);
      await startDownload(env, { chatId, videoId, choice, useVpn: true });
      return;
    }

    if (action === "o") {
      await tg(env, "answerCallbackQuery", { callback_query_id: query.id, text: "Balas pesan perintah dengan config .ovpn-nya." });
      await clearKeyboard(env, chatId, messageId);
      await tg(env, "sendMessage", {
        chat_id: chatId,
        parse_mode: "HTML",
        text:
          `📄 <b>Gunakan custom config OpenVPN</b> — ${label}\n\n` +
          "Balas (reply) pesan ini dengan salah satu:\n" +
          "• file <b>.ovpn</b> (kirim sebagai dokumen), atau\n" +
          "• <b>tempel isi config-nya</b> sebagai teks, atau\n" +
          "• <b>link raw</b> config-nya — bot akan mengambil dari link itu.\n\n" +
          "Bila config-nya butuh username/password, bot akan memintanya " +
          "setelah ini; bila tidak, download langsung dimulai.\n\n" +
          `<code>px:${videoId}:${choice}</code>\novpn:cfg`,
        reply_markup: { force_reply: true, input_field_placeholder: "File .ovpn / teks config / link raw" },
      });
      return;
    }

    if (action === "l") {
      await tg(env, "answerCallbackQuery", { callback_query_id: query.id, text: "Balas pesan perintah dengan link config-nya." });
      await clearKeyboard(env, chatId, messageId);
      await tg(env, "sendMessage", {
        chat_id: chatId,
        parse_mode: "HTML",
        text:
          `🌐 <b>Download config OpenVPN dari link</b> — ${label}\n\n` +
          "Balas (reply) pesan ini dengan <b>link download config</b> " +
          ".ovpn-nya (mis. link unduhan VPNGate) — bot akan mengambil " +
          "config-nya dari link itu. Bila config-nya butuh username/" +
          "password, bot akan memintanya setelah ini; bila tidak, " +
          "download langsung dimulai.\n\n" +
          `<code>px:${videoId}:${choice}</code>\novpn:link`,
        reply_markup: { force_reply: true, input_field_placeholder: "https://... link config .ovpn" },
      });
      return;
    }

    if (action === "c") {
      await tg(env, "answerCallbackQuery", { callback_query_id: query.id, text: "Balas pesan perintah dengan URL proxy-nya." });
      await clearKeyboard(env, chatId, messageId);
      await tg(env, "sendMessage", {
        chat_id: chatId,
        parse_mode: "HTML",
        text:
          `🔌 <b>Download menggunakan proxy custom</b> — ${label}\n\n` +
          "Balas (reply) pesan ini dengan URL proxy-nya saja, contoh:\n" +
          "<code>socks5://user:pass@host:port</code>\n" +
          "Skema yang didukung: http, https, socks4, socks5.\n" +
          "Format host:port:user:pass dari penjual proxy juga diterima, " +
          "nanti diubah otomatis ke bentuk URL.\n\n" +
          `<code>px:${videoId}:${choice}</code>`,
        reply_markup: { force_reply: true, input_field_placeholder: "socks5://user:pass@host:port" },
      });
      return;
    }
    return;
  }

  // Tombol format dari hasil probe: dl:<videoId>:<choice>
  if (parts.length !== 3 || parts[0] !== "dl") return;
  const [, videoId, choice] = parts;

  if (choice === "cancel") {
    await tg(env, "answerCallbackQuery", { callback_query_id: query.id });
    if (messageId) {
      await tg(env, "editMessageCaption", { chat_id: chatId, message_id: messageId, caption: "✖️ Dibatalkan." }).catch(() => {});
    }
    return;
  }
  const label = choiceLabel(choice);
  if (!label) return;

  // Jangan langsung download: tawarkan dulu 6 cara download.
  await tg(env, "answerCallbackQuery", { callback_query_id: query.id, text: `${label} — pilih cara download.` });
  await clearKeyboard(env, chatId, messageId);
  await tg(env, "sendMessage", {
    chat_id: chatId,
    parse_mode: "HTML",
    text: `<b>${label}</b>\nPilih cara download:`,
    reply_markup: downloadChoiceKeyboard(videoId, choice),
  });
}

// ---------------------------------------------------------------- entry
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/") {
      return new Response("YouTube Telegram Bot Worker — OK", { status: 200 });
    }

    // Daftarkan webhook ke URL Worker ini sendiri. Lindungi dengan secret yang sama:
    // buka /set-webhook?secret=<TELEGRAM_WEBHOOK_SECRET>
    if (request.method === "GET" && url.pathname === "/set-webhook") {
      if (!env.TELEGRAM_WEBHOOK_SECRET || url.searchParams.get("secret") !== env.TELEGRAM_WEBHOOK_SECRET) {
        return new Response("Forbidden", { status: 403 });
      }
      const webhookUrl = `${url.origin}/webhook`;
      const data = await tg(env, "setWebhook", {
        url: webhookUrl,
        secret_token: env.TELEGRAM_WEBHOOK_SECRET,
        drop_pending_updates: true,
        allowed_updates: ["message", "callback_query"],
      });
      return Response.json({ webhook: webhookUrl, telegram: data });
    }

    if (request.method === "POST" && url.pathname === "/webhook") {
      // Verifikasi webhook asli dari Telegram
      if (env.TELEGRAM_WEBHOOK_SECRET) {
        const secret = request.headers.get("x-telegram-bot-api-secret-token");
        if (secret !== env.TELEGRAM_WEBHOOK_SECRET) return new Response("Forbidden", { status: 403 });
      }
      let update;
      try {
        update = await request.json();
      } catch {
        return new Response("Bad Request", { status: 400 });
      }
      // Balas 200 ke Telegram secepatnya, proses lanjut di background
      ctx.waitUntil(
        (async () => {
          try {
            if (update.message) await handleMessage(env, update.message);
            else if (update.callback_query) await handleCallback(env, update.callback_query);
          } catch (e) {
            console.error("handle update gagal", e);
          }
        })()
      );
      return new Response("OK", { status: 200 });
    }

    return new Response("Not Found", { status: 404 });
  },
};
