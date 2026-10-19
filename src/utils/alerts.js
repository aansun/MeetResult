const fs = require("fs");
const path = require("path");
const config = require("../config/config");

// Peringatan masalah (provider notulen/transkripsi gagal, rekaman gagal difinalisasi, dsb)
// yang ditampilkan tray sebagai notifikasi + daftar di menu. File TERPISAH dari
// watcher-meta.json karena meta itu dihapus tiap watcher berhenti, sedangkan peringatan harus
// tetap ada sampai user melihatnya. Dipakai lintas proses (watcher, `meetresult retry`, dll).
const alertsFile = path.join(config.DATA_DIR, "alerts.json");
const MAX_ALERTS = 30;

function readAlerts() {
  try {
    const list = JSON.parse(fs.readFileSync(alertsFile, "utf-8"));
    return Array.isArray(list) ? list : [];
  } catch (e) {
    return [];
  }
}

/**
 * Catat 1 peringatan. level: "warning" (masalah tapi sudah teratasi, mis. provider utama gagal
 * tapi fallback berhasil) atau "error" (benar-benar gagal, perlu tindakan). kind: "notulen" |
 * "transkripsi" | "rekaman" | "proses". Tidak pernah melempar error - gagal menulis alert tidak
 * boleh ikut menggagalkan proses utama.
 */
function recordAlert({ level = "warning", kind, message, meeting }) {
  try {
    const list = readAlerts();
    list.push({
      id: Date.now(),
      at: new Date().toISOString(),
      level,
      kind,
      meeting: meeting || null,
      message: String(message || "").replace(/\s+/g, " ").slice(0, 400),
    });
    fs.writeFileSync(alertsFile, JSON.stringify(list.slice(-MAX_ALERTS), null, 2), "utf-8");
  } catch (e) {}
}

module.exports = { recordAlert, readAlerts, alertsFile };
