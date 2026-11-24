// Klasifikasi pesan error provider AI (CLI/HTTP) - supaya tahu mana yang layak diulang
// (gangguan jaringan/server sesaat) dan mana yang butuh tindakan user (login habis).

// Gangguan sementara: ulangi sekali setelah jeda sebelum pindah ke fallback.
const TRANSIENT_RE =
  /ENOTFOUND|ETIMEDOUT|ECONNRESET|ECONNREFUSED|EAI_AGAIN|EPIPE|socket hang up|fetch failed|terminated|network issue|network error|can'?t reach|timeout|timed out|overloaded|high demand|temporarily|try again|\b(429|500|502|503|504)\b|respons kosong/i;

// Login/kredensial habis: TIDAK ada gunanya diulang - harus login ulang manual.
const AUTH_RE =
  /Authentication required|authentication (failed|timed out)|OAuth|Failed to authenticate|not logged in|please (log ?in|visit the url)|claude login|invalid[_ ]api[_ ]key|\b401\b|unauthorized/i;

function isTransientProviderError(message) {
  return TRANSIENT_RE.test(String(message || "")) && !AUTH_RE.test(String(message || ""));
}

function isAuthProviderError(message) {
  return AUTH_RE.test(String(message || ""));
}

/** Petunjuk langkah perbaikan per provider untuk error login - dipakai di alert & hasil tes. */
function authHint(provider, claudeBinPath) {
  if (provider === "agy") return "Login ulang Antigravity: jalankan 'agy' di terminal lalu selesaikan login Google.";
  if (provider === "claude") {
    return `Login ulang Claude: jalankan '${claudeBinPath || "claude"} login' di terminal.`;
  }
  return "Cek kredensial/API key provider ini.";
}

module.exports = { isTransientProviderError, isAuthProviderError, authHint };
