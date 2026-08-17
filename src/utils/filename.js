const fs = require("fs");
const path = require("path");

/**
 * Bersihkan string agar aman dipakai sebagai nama file di macOS/Windows/Linux.
 * Menghapus karakter terlarang: \ / : * ? " < > |
 */
function sanitizeFileNamePart(str) {
  return String(str || "")
    .trim()
    .replace(/[\\/:*?"<>|]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Format tanggal menjadi YYYYMMDD
 */
function toYYYYMMDD(date) {
  const d = date instanceof Date ? date : new Date(date);
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}${mm}${dd}`;
}

/**
 * Bangun nama file unik: "{JudulMeeting}_{YYYYMMDD}.ext"
 * Jika sudah ada file dengan nama sama, tambahkan sufiks (2), (3), dst.
 */
function buildUniqueFileName(dir, title, date, ext) {
  const safeTitle = sanitizeFileNamePart(title) || "Meeting";
  const dateStr = toYYYYMMDD(date);
  const baseName = `${safeTitle}_${dateStr}`;
  const extension = ext.startsWith(".") ? ext : `.${ext}`;

  let candidate = `${baseName}${extension}`;
  let counter = 2;
  while (fs.existsSync(path.join(dir, candidate))) {
    candidate = `${baseName}(${counter})${extension}`;
    counter++;
  }
  return candidate;
}

module.exports = { sanitizeFileNamePart, toYYYYMMDD, buildUniqueFileName };
