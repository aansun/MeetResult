const { execSync } = require("child_process");
const os = require("os");

/**
 * Cek apakah aplikasi Microsoft Teams sedang berjalan di komputer ini. Dipakai sebagai
 * salah satu sinyal (BUKAN satu-satunya) untuk menghindari auto-record meeting yang
 * jadwalnya ada di kalender tapi Teams-nya sama sekali tidak dibuka (mis. meeting
 * di-cancel/reschedule tapi event lama masih ada) - lihat detection.requireTeamsRunning
 * & detection.silenceCheckAfterMinutes di config.
 */
function isTeamsRunning() {
  if (os.platform() !== "darwin") return true; // tidak bisa dicek di platform lain, jangan blokir
  try {
    execSync('pgrep -x "MSTeams"', { stdio: "ignore" });
    return true;
  } catch (e) {
    return false; // pgrep exit code 1 = tidak ada proses ditemukan
  }
}

module.exports = { isTeamsRunning };
