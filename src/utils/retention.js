const fs = require("fs");
const path = require("path");
const config = require("../config/config");
const logger = require("../utils/logger");
const db = require("../storage/db");

/**
 * Hapus otomatis file audio (.wav) di folder recordings yang sudah lebih tua
 * dari AUDIO_RETENTION_DAYS. Transkrip (.txt) dan notulen (.docx) TIDAK dihapus.
 */
function cleanupOldRecordings() {
  const days = config.retention.audioDays;
  if (!days || days <= 0) return { deleted: [] };

  const maxAgeMs = days * 24 * 60 * 60 * 1000;
  const now = Date.now();
  const deleted = [];

  if (!fs.existsSync(config.RECORDINGS_DIR)) return { deleted };

  const files = fs.readdirSync(config.RECORDINGS_DIR);
  for (const file of files) {
    if (file === ".gitkeep") continue;
    const fullPath = path.join(config.RECORDINGS_DIR, file);
    let stat;
    try {
      stat = fs.statSync(fullPath);
    } catch (e) {
      continue;
    }
    if (!stat.isFile()) continue;

    const age = now - stat.mtimeMs;
    if (age > maxAgeMs) {
      try {
        fs.unlinkSync(fullPath);
        deleted.push(fullPath);
        logger.info(
          `Audio dihapus otomatis (retensi ${days} hari): ${file}`
        );
      } catch (e) {
        logger.warn(`Gagal menghapus ${file}: ${e.message}`);
      }
    }
  }

  if (deleted.length > 0) {
    // Tandai di db bahwa audioFile sudah tidak tersedia lagi
    const allMeetings = db.listMeetings();
    for (const m of allMeetings) {
      if (m.audioFile && deleted.includes(m.audioFile)) {
        db.updateMeeting(m.id, { audioFile: null, audioDeletedAt: new Date().toISOString() });
      }
    }
  }

  return { deleted };
}

module.exports = { cleanupOldRecordings };
