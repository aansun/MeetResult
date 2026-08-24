const fs = require("fs");
const path = require("path");
const config = require("../config/config");

// File status watcher (PID, waktu start, kesehatan fetch kalender) - dibaca oleh tray Swift
// untuk deteksi kode/config berubah (lihat CLAUDE_CLI_MODE dsb) DAN sekarang juga untuk
// menampilkan peringatan kalau fetch kalender gagal berulang kali (lihat updateStatus() di
// MeetResultTray.swift).
const metaFile = path.join(config.DATA_DIR, "watcher-meta.json");

function readWatcherMeta() {
  try {
    return JSON.parse(fs.readFileSync(metaFile, "utf-8"));
  } catch (e) {
    return {};
  }
}

function updateWatcherMeta(partial) {
  const current = readWatcherMeta();
  try {
    fs.writeFileSync(metaFile, JSON.stringify({ ...current, ...partial }, null, 2), "utf-8");
  } catch (e) {
    // Tidak fatal - kalau gagal tulis (mis. disk penuh), watcher tetap lanjut jalan normal,
    // cuma tray tidak akan lihat status terbaru.
  }
}

module.exports = { metaFile, readWatcherMeta, updateWatcherMeta };
