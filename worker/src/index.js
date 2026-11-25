/**
 * YouTube Telegram Bot — Cloudflare Worker (webhook handler)
 * ===========================================================
 * Tugas Worker ini HANYA:
 *   1. Terima webhook Telegram
 *   2. Saat user mengirim link: LANGSUNG tampilkan menu cara download
 *      (tanpa proxy / proxy custom / profile OpenVPN tersimpan /
 *      custom config OpenVPN / config OpenVPN dari link / batal).
 *      Cara yang dipilih dipakai dulu untuk probe — probe mengekstrak
 *      format yang benar-benar tersedia (s/d 8K) + perkiraan ukurannya,
 *      lalu mengirim foto + tombol format dinamis ke chat. Probe yang
 *      jalan tanpa proxy dulu sering mentok di bot-check YouTube
 *      ("Sign in to confirm you're not a bot") sebelum user sempat
 *      memilih proxy/VPN; dengan pilihan di awal, probe sudah berjalan
 *      lewat proxy/VPN yang dipilih.
 *   3. Saat tombol resolusi diklik, download langsung dimulai dengan
 *      cara yang SAMA seperti saat probe (cara itu dibawa tombol format
 *      dari downloader, "dl:<videoId>:<choice>|<n|v|p<proxy>>") —
 *      kecuali bila probe memakai config OpenVPN custom (config tidak
 *      bisa dibawa lewat tombol, batas callback Telegram 64 byte),
 *      maka menu cara download ditampilkan lagi seperti dulu.
 *      "Tanpa proxy" langsung trigger mode "download"; "proxy custom"
 *      membalas user dengan pesan perintah (force reply) yang membawa
 *      kode tugas "px:<videoId>:<choice>" — user membalasnya dengan
 *      URL proxy (boleh beberapa sekaligus, bulk; downloader mencoba
 *      satu-satu sampai ada yang berhasil), lalu download ditrigger
 *      memakai proxy itu.
 *      "Profile tersimpan" mentrigger download dengan input use_vpn=1
 *      (workflow menyambungkan VPN dari secret OPENVPN_CONFIG).
 *      "Custom config" meminta user membalas prompt dengan file .ovpn,
 *      tempelan teks config, atau link raw config (Worker mengambilnya
 *      dari link itu); bila config butuh login (ada baris
 *      auth-user-pass), bot meminta username + password dalam satu
 *      balasan lagi — prompt kedua membawa serta config-nya karena
 *      Worker tidak punya penyimpanan: file_id untuk config berkas
 *      (ovpnfile:<file_id>), atau isi config tersemat di antara
 *      penanda ovpncfg:begin/ovpncfg:end untuk config teks/link yang
 *      cukup pendek. Config lalu diteruskan ke workflow sebagai
 *      input ovpn_config. Pilihan yang sama juga muncul di
 *      pesan gagal dari downloader, jadi user bisa langsung mencoba
 *      cara lain tanpa mengulang dari awal.
 *      Untuk probe, kode tugasnya "pre:<videoId>" (tanpa choice,
 *      karena format belum dipilih) dan alur balasannya sama persis,
 *      hanya akhirnya mentrigger mode "probe", bukan "download".
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

// Tampilan aman untuk DAFTAR proxy (bulk, dipisah spasi): proxy pertama
// + jumlah sisanya, supaya pesan status tidak kepanjangan.
function maskProxyList(proxy) {
  const list = String(proxy || "").split(/\s+/).filter(Boolean);
  if (!list.length) return "";
  const first = maskProxy(list[0]);
  return list.length === 1 ? first : `${first} (+${list.length - 1} lainnya)`;
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

// Keyboard yang sama persis, tapi untuk PROBE (sebelum format dipilih).
// Callback-nya "pre:<videoId>:<aksi>" — tanpa choice, karena format
// baru diketahui setelah probe berhasil. Dipakai saat user pertama
// kali mengirim link, dan di pesan gagal probe dari downloader.
function probeChoiceKeyboard(videoId) {
  return {
    inline_keyboard: [
      [{ text: "⬇️ Download tanpa proxy", callback_data: `pre:${videoId}:n` }],
      [{ text: "🔌 Download menggunakan proxy custom", callback_data: `pre:${videoId}:c` }],
      [{ text: "🛡️ Gunakan profile OpenVPN yang tersimpan", callback_data: `pre:${videoId}:v` }],
      [{ text: "📄 Gunakan custom config OpenVPN", callback_data: `pre:${videoId}:o` }],
      [{ text: "🌐 Download config OpenVPN dari link", callback_data: `pre:${videoId}:l` }],
      [{ text: "✖️ Batalkan / Cancel tugas", callback_data: `pre:${videoId}:x` }],
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
        (proxy ? `\n🔌 Proxy: ${maskProxyList(proxy)}` : "") +
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

// Trigger mode probe + kirim pesan placeholder "sedang memeriksa".
// Probe memakai proxy/VPN yang sama seperti yang akan dipakai download,
// supaya tidak mentok bot-check YouTube sebelum user sempat memilih cara.
async function startProbe(env, { chatId, videoId, proxy = "", useVpn = false, ovpn = null }) {
  const placeholder = await tg(env, "sendMessage", {
    chat_id: chatId,
    parse_mode: "HTML",
    text:
      "🔍 Sedang memeriksa kualitas & ukuran yang tersedia...\n" +
      "(sekitar 1 menit, prosesnya di GitHub Actions)" +
      (proxy ? `\n🔌 Proxy: ${maskProxyList(proxy)}` : "") +
      (useVpn && ovpn ? "\n🛡️ VPN: OpenVPN (custom config)" : "") +
      (useVpn && !ovpn ? "\n🛡️ VPN: OpenVPN (profile tersimpan)" : ""),
  });
  const probeMessageId = placeholder?.result?.message_id || "";
  const result = await triggerGithubActions(env, {
    chatId, videoId, choice: "probe", mode: "probe", probeMessageId,
    proxy, proxyCustom: !!proxy, useVpn,
    ovpnConfig: ovpn?.config || "", ovpnUser: ovpn?.user || "", ovpnPass: ovpn?.pass || "",
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
    const repliedText = String(replied.text || replied.caption || "");
    // Dua macam tugas menunggu balasan user:
    //  - download: "px:<videoId>:<choice>" (format sudah dipilih)
    //  - probe:    "pre:<videoId>" (format belum dipilih; balasan ini
    //    menentukan cara probe, lalu download memakai cara yang sama)
    const pxToken = repliedText.match(/px:([\w-]{11}):([a-z0-9_]+)/);
    const preToken = !pxToken && repliedText.match(/pre:([\w-]{11})\b/);
    const pendingKind = pxToken ? "download" : preToken ? "probe" : null;
    if (pendingKind && (pendingKind === "probe" || choiceLabel(pxToken[2]))) {
      const pendingVideoId = pendingKind === "probe" ? preToken[1] : pxToken[1];
      const pendingChoice = pendingKind === "probe" ? "probe" : pxToken[2];
      const pendingCode = pendingKind === "probe"
        ? `pre:${pendingVideoId}`
        : `px:${pendingVideoId}:${pendingChoice}`;
      const pendingLabel = pendingKind === "probe"
        ? "cek kualitas"
        : choiceLabel(pendingChoice) || pendingChoice;

      // Penyelesaian tugas menunggu: probe atau download, sesuai jenisnya.
      const finishPending = async ({ proxy = "", useVpn = false, ovpn = null } = {}) => {
        if (pendingKind === "probe") {
          return startProbe(env, { chatId, videoId: pendingVideoId, proxy, useVpn, ovpn });
        }
        return startDownload(env, {
          chatId, videoId: pendingVideoId, choice: pendingChoice, proxy, useVpn, ovpn,
        });
      };

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
            text: pendingKind === "probe"
              ? "❌ Config OpenVPN-nya tidak bisa dibaca lagi. Kirim link-nya lagi ya."
              : "❌ Config OpenVPN-nya tidak bisa dibaca lagi. Ulangi dari pilihan resolusi ya.",
          });
          return;
        }
        if (replied.message_id) {
          await tg(env, "editMessageText", {
            chat_id: chatId, message_id: replied.message_id,
            text: pendingKind === "probe"
              ? "✅ Kredensial diterima. Pengecekan dimulai..."
              : "✅ Kredensial diterima. Download dimulai...",
          }).catch(() => {});
        }
        await finishPending({
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
            await sendCredPrompt(`<code>${pendingCode}\novpnfile:${fileId}</code>`);
          } else if (sourceUrl) {
            await sendCredPrompt(`<code>${pendingCode}\novpnurl:${escapeHtml(sourceUrl)}</code>`);
          } else if (cfg.length <= 3500) {
            // Config teks: sematkan isinya di prompt kredensial
            // (diapit penanda ovpncfg) karena tidak ada file_id/URL.
            await sendCredPrompt(
              `<code>${pendingCode}</code>\n` +
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
            text: pendingKind === "probe"
              ? "✅ Config diterima. Pengecekan dimulai..."
              : "✅ Config diterima. Download dimulai...",
          }).catch(() => {});
        }
        await finishPending({
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

      // Bulk proxy: user boleh mengirim BEBERAPA proxy sekaligus
      // (satu per baris, atau dipisah spasi/koma). Semuanya
      // dinormalisasi + didedup, maks 50 — downloader mencoba satu-satu
      // sampai ada yang berhasil, sisanya yang belum dipakai diabaikan.
      const tokens = String(text).split(/[\s,;]+/).filter(Boolean);
      const candidates = [];
      let skipped = 0;
      for (const w of tokens) {
        if (/(?:youtube\.com|youtu\.be)/i.test(w)) continue;
        const norm = normalizeProxyToken(w);
        if (norm && !candidates.includes(norm)) candidates.push(norm);
        else if (!norm) skipped++;
      }
      const picked = candidates.slice(0, 50);
      if (!picked.length) {
        await tg(env, "sendMessage", {
          chat_id: chatId,
          text:
            "❌ Itu bukan proxy yang valid. Balas pesan perintah tadi " +
            "dengan proxy-nya saja, contoh:\nsocks5://user:pass@host:port\n" +
            "atau format host:port:user:pass dari penjual proxy.\n" +
            "Bisa juga kirim beberapa proxy sekaligus (satu per baris) — " +
            "bot mencoba satu-satu sampai ada yang berhasil.",
        });
        return;
      }
      if (replied.message_id) {
        const note = picked.length > 1
          ? `✅ ${picked.length} proxy diterima (${maskProxyList(picked.join(" "))}). Dicoba satu-satu sampai ada yang berhasil...`
          : `✅ Proxy diterima (${maskProxy(picked[0])}).`;
        const extra = skipped ? ` (${skipped} baris diabaikan, bukan proxy valid)` : "";
        const capped = candidates.length > 50 ? " (hanya 50 pertama dipakai)" : "";
        await tg(env, "editMessageText", {
          chat_id: chatId, message_id: replied.message_id,
          text: pendingKind === "probe"
            ? `${note}${extra}${capped} Pengecekan dimulai...`
            : `${note}${extra}${capped} Download dimulai...`,
        }).catch(() => {});
      }
      await finishPending({ proxy: picked.join(" ") });
      return;
    }
  }

  if (text.startsWith("/start") || text.startsWith("/help")) {
    await tg(env, "sendMessage", {
      chat_id: chatId,
      parse_mode: "HTML",
      text:
        "👋 <b>YouTube Downloader Bot</b>\n\n" +
        "Kirimkan link YouTube, lalu pilih dulu cara download-nya:\n" +
        "⬇️ <b>Download tanpa proxy</b> — langsung diproses\n" +
        "🔌 <b>Download menggunakan proxy custom</b> — kamu akan diminta " +
        "mengirim URL proxy (boleh beberapa sekaligus, dicoba satu-satu " +
        "sampai berhasil), lalu download memakai proxy itu\n" +
        "🛡️ <b>Gunakan profile OpenVPN yang tersimpan</b> — download " +
        "lewat VPN dari config .ovpn di secret repo\n" +
        "📄 <b>Gunakan custom config OpenVPN</b> — kamu mengirim config " +
        ".ovpn sendiri (file, tempelan teks, atau link raw); bila butuh " +
        "login, bot akan meminta username &amp; password-nya\n" +
        "🌐 <b>Download config OpenVPN dari link</b> — kamu mengirim " +
        "link unduhan config-nya (mis. VPNGate), bot yang mengambil " +
        "config-nya\n" +
        "✖️ <b>Batalkan / Cancel tugas</b> — batalkan tugas\n\n" +
        "Cara yang kamu pilih dipakai dulu untuk mengecek kualitas yang " +
        "tersedia (sampai 8K bila ada) lengkap dengan perkiraan " +
        "ukurannya — 🎬 <b>Video</b> sesuai resolusi asli, 🎵 <b>Audio</b> " +
        "MP3 / M4A — supaya pengecekan tidak mentok bot-check YouTube. " +
        "Setelah kamu klik format, download langsung jalan dengan cara " +
        "yang sama. Satu pengecualian: config OpenVPN custom harus " +
        "dikirim ulang setelah pilih format, karena bot tidak menyimpan " +
        "config.\n\n" +
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

  // Link diterima: JANGAN langsung probe. Tampilkan dulu menu cara
  // download (tombol yang sama seperti di foto menu) — cara yang dipilih
  // dipakai untuk probe, supaya probe tidak mentok bot-check YouTube
  // sebelum user sempat memilih proxy/VPN. Probe dipicu dari callback
  // "pre:<videoId>:<aksi>" di handleCallback.
  await tg(env, "sendMessage", {
    chat_id: chatId,
    parse_mode: "HTML",
    text:
      "🔍 <b>Link diterima.</b>\n" +
      "Pilih dulu cara mengecek &amp; download video ini — pengecekan " +
      "kualitas (sampai 8K bila ada) akan memakai cara yang sama, " +
      "supaya tidak mentok bot-check YouTube. Setelah kamu klik format, " +
      "download langsung jalan dengan cara yang sama.",
    reply_markup: probeChoiceKeyboard(videoId),
  });
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

  // Tombol format dari hasil probe: dl:<videoId>:<choice>[|<cara>]
  // <cara> dibawa dari probe (downloader yang menyematkannya):
  //   n = tanpa proxy, v = profile OpenVPN tersimpan,
  //   p<proxy> = proxy custom yang dipakai probe.
  // Bila ada, download langsung jalan dengan cara yang sama — user tidak
  // perlu memilih lagi. Bila tidak ada (probe memakai config OpenVPN
  // custom, atau tombol dari probe lama), tampilkan menu cara download.
  // Diparse manual (bukan split(":")) karena proxy di <cara> mengandung ":".
  if (data.startsWith("dl:")) {
    const rest = data.slice(3);
    const sep = rest.indexOf(":");
    if (sep < 0) return;
    const videoId = rest.slice(0, sep);
    const choiceRaw = rest.slice(sep + 1);
    const [choice, method] = String(choiceRaw).split("|");

    if (choice === "cancel") {
      await tg(env, "answerCallbackQuery", { callback_query_id: query.id });
      if (messageId) {
        await tg(env, "editMessageCaption", { chat_id: chatId, message_id: messageId, caption: "✖️ Dibatalkan." }).catch(() => {});
      }
      return;
    }
    const label = choiceLabel(choice);
    if (!label) return;

    if (method === "n") {
      await tg(env, "answerCallbackQuery", { callback_query_id: query.id, text: `${label} — tanpa proxy (sama seperti saat cek), diproses...` });
      await clearKeyboard(env, chatId, messageId);
      await startDownload(env, { chatId, videoId, choice, proxy: "" });
      return;
    }
    if (method === "v") {
      await tg(env, "answerCallbackQuery", { callback_query_id: query.id, text: `${label} — profile OpenVPN tersimpan (sama seperti saat cek), diproses...` });
      await clearKeyboard(env, chatId, messageId);
      await startDownload(env, { chatId, videoId, choice, useVpn: true });
      return;
    }
    if (method && method.startsWith("p")) {
      const proxy = normalizeProxyToken(method.slice(1));
      if (proxy) {
        await tg(env, "answerCallbackQuery", { callback_query_id: query.id, text: `${label} — proxy yang sama seperti saat cek, diproses...` });
        await clearKeyboard(env, chatId, messageId);
        await startDownload(env, { chatId, videoId, choice, proxy });
        return;
      }
      // Proxy dari tombol tidak valid — jatuh ke menu di bawah.
    }

    // Tidak ada cara bawaan: tawarkan dulu 6 cara download.
    await tg(env, "answerCallbackQuery", { callback_query_id: query.id, text: `${label} — pilih cara download.` });
    await clearKeyboard(env, chatId, messageId);
    await tg(env, "sendMessage", {
      chat_id: chatId,
      parse_mode: "HTML",
      text: `<b>${label}</b>\nPilih cara download:`,
      reply_markup: downloadChoiceKeyboard(videoId, choice),
    });
    return;
  }

  const parts = data.split(":");

  // Menu cara PROBE (saat link pertama dikirim): pre:<videoId>:<n|c|v|o|l|x>
  // (n = tanpa proxy, c = proxy custom, v = profile OpenVPN tersimpan,
  //  o = custom config OpenVPN, l = config OpenVPN dari link,
  //  x = batalkan). Pilihan di sini menentukan cara probe; download
  // nanti memakai cara yang sama (kecuali config OpenVPN custom).
  if (parts.length === 3 && parts[0] === "pre") {
    const [, videoId, action] = parts;

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
      await tg(env, "answerCallbackQuery", { callback_query_id: query.id, text: "Cek tanpa proxy, diproses..." });
      await clearKeyboard(env, chatId, messageId);
      await startProbe(env, { chatId, videoId, proxy: "" });
      return;
    }

    if (action === "v") {
      await tg(env, "answerCallbackQuery", { callback_query_id: query.id, text: "Cek via profile OpenVPN tersimpan, diproses..." });
      await clearKeyboard(env, chatId, messageId);
      await startProbe(env, { chatId, videoId, useVpn: true });
      return;
    }

    if (action === "o") {
      await tg(env, "answerCallbackQuery", { callback_query_id: query.id, text: "Balas pesan perintah dengan config .ovpn-nya." });
      await clearKeyboard(env, chatId, messageId);
      await tg(env, "sendMessage", {
        chat_id: chatId,
        parse_mode: "HTML",
        text:
          "📄 <b>Gunakan custom config OpenVPN</b> — cek kualitas\n\n" +
          "Balas (reply) pesan ini dengan salah satu:\n" +
          "• file <b>.ovpn</b> (kirim sebagai dokumen), atau\n" +
          "• <b>tempel isi config-nya</b> sebagai teks, atau\n" +
          "• <b>link raw</b> config-nya — bot akan mengambil dari link itu.\n\n" +
          "Bila config-nya butuh username/password, bot akan memintanya " +
          "setelah ini; bila tidak, pengecekan langsung dimulai.\n" +
          "Catatan: config dipakai dulu untuk cek kualitas. Setelah kamu " +
          "pilih format, config-nya perlu dikirim ulang, karena bot " +
          "tidak menyimpan config.\n\n" +
          `<code>pre:${videoId}</code>\novpn:cfg`,
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
          "🌐 <b>Download config OpenVPN dari link</b> — cek kualitas\n\n" +
          "Balas (reply) pesan ini dengan <b>link download config</b> " +
          ".ovpn-nya (mis. link unduhan VPNGate) — bot akan mengambil " +
          "config-nya dari link itu. Bila config-nya butuh username/" +
          "password, bot akan memintanya setelah ini; bila tidak, " +
          "pengecekan langsung dimulai.\n" +
          "Catatan: config dipakai dulu untuk cek kualitas. Setelah kamu " +
          "pilih format, config-nya perlu dikirim ulang, karena bot " +
          "tidak menyimpan config.\n\n" +
          `<code>pre:${videoId}</code>\novpn:link`,
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
          "🔌 <b>Download menggunakan proxy custom</b> — cek kualitas\n\n" +
          "Balas (reply) pesan ini dengan URL proxy-nya saja, contoh:\n" +
          "<code>socks5://user:pass@host:port</code>\n" +
          "Skema yang didukung: http, https, socks4, socks5.\n" +
          "Format host:port:user:pass dari penjual proxy juga diterima, " +
          "nanti diubah otomatis ke bentuk URL.\n" +
          "Bisa kirim beberapa proxy sekaligus (satu per baris) — bot " +
          "mencoba satu-satu sampai ada yang berhasil; yang gagal " +
          "dilaporkan, yang belum dipakai diabaikan.\n\n" +
          "Proxy ini dipakai dulu untuk mengecek kualitas, lalu dipakai " +
          "lagi untuk download setelah kamu pilih format.\n\n" +
          `<code>pre:${videoId}</code>`,
        reply_markup: { force_reply: true, input_field_placeholder: "socks5://user:pass@host:port" },
      });
      return;
    }
    return;
  }

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
          "nanti diubah otomatis ke bentuk URL.\n" +
          "Bisa kirim beberapa proxy sekaligus (satu per baris) — bot " +
          "mencoba satu-satu sampai ada yang berhasil; yang gagal " +
          "dilaporkan, yang belum dipakai diabaikan.\n\n" +
          `<code>px:${videoId}:${choice}</code>`,
        reply_markup: { force_reply: true, input_field_placeholder: "socks5://user:pass@host:port" },
      });
      return;
    }
    return;
  }
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
