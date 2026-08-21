const fs = require("fs");
const path = require("path");
const os = require("os");
const logger = require("./logger");

// Lokasi umum tempat Claude Desktop menaruh symlink CLI `claude` di macOS (Homebrew-managed).
// Kalau kamu install `claude` dengan cara lain (bukan symlink ke folder versi Claude Desktop),
// fungsi ini TIDAK akan menyentuhnya sama sekali - lihat isBrokenClaudeDesktopSymlink().
const CANDIDATE_SYMLINK_DIRS = ["/opt/homebrew/bin", "/usr/local/bin", path.join(os.homedir(), ".local/bin")];
const CLAUDE_VERSIONS_DIR = path.join(os.homedir(), "Library", "Application Support", "Claude", "claude-code");

/**
 * True kalau `linkPath` adalah symlink YANG MENUNJUK ke folder versi Claude Desktop
 * (".../Claude/claude-code/<versi>/...") tapi targetnya sudah tidak ada - ini terjadi kalau
 * Claude Desktop auto-update ke versi baru dan folder versi lama dihapus, sementara symlink
 * `claude` di PATH masih menunjuk ke path versi lama itu.
 */
function isBrokenClaudeDesktopSymlink(linkPath) {
  let lstat;
  try {
    lstat = fs.lstatSync(linkPath);
  } catch (e) {
    return false; // tidak ada apa-apa di path ini - bukan urusan kita
  }
  if (!lstat.isSymbolicLink()) return false; // instalasi lain (binary asli/symlink custom) - JANGAN disentuh

  let target;
  try {
    target = fs.readlinkSync(linkPath);
  } catch (e) {
    return false;
  }
  if (!target.includes(path.join("Claude", "claude-code"))) return false; // bukan pola symlink Claude Desktop

  return !fs.existsSync(linkPath); // fs.existsSync ikut symlink -> false kalau targetnya hilang
}

/**
 * Cari binary `claude` dari versi Claude Desktop TERBARU yang terinstall & valid di mesin ini.
 */
function findLatestClaudeDesktopBinary() {
  if (!fs.existsSync(CLAUDE_VERSIONS_DIR)) return null;

  const versions = fs
    .readdirSync(CLAUDE_VERSIONS_DIR)
    .filter((name) => {
      try {
        return fs.statSync(path.join(CLAUDE_VERSIONS_DIR, name)).isDirectory();
      } catch (e) {
        return false;
      }
    })
    .sort((a, b) => {
      // Urutkan numerik per segmen versi (mis. "2.1.237" > "2.1.234"), DESCENDING (terbaru dulu)
      const pa = a.split(".").map(Number);
      const pb = b.split(".").map(Number);
      for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
        const diff = (pb[i] || 0) - (pa[i] || 0);
        if (diff !== 0 && !Number.isNaN(diff)) return diff;
      }
      return 0;
    });

  for (const version of versions) {
    const candidate = path.join(CLAUDE_VERSIONS_DIR, version, "claude.app", "Contents", "MacOS", "claude");
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * Cek semua lokasi symlink `claude` yang umum dipakai - kalau ada yang rusak akibat Claude
 * Desktop auto-update (lihat isBrokenClaudeDesktopSymlink()), perbaiki otomatis dengan
 * mengarahkan ulang ke versi terbaru yang valid. TIDAK perlu restart apapun - `spawn()`
 * me-resolve ulang symlink setiap kali dipanggil, jadi perbaikan ini langsung aktif untuk
 * pemanggilan `claude` berikutnya.
 *
 * Return: array hasil { path, repaired, target?, error? } untuk tiap symlink yang DIPERBAIKI
 * (kosong kalau semua sehat / tidak ada yang perlu diperbaiki).
 */
function checkAndRepairClaudeCliSymlinks() {
  if (os.platform() !== "darwin") return [];

  const repaired = [];
  for (const dir of CANDIDATE_SYMLINK_DIRS) {
    const linkPath = path.join(dir, "claude");
    if (!isBrokenClaudeDesktopSymlink(linkPath)) continue;

    const latest = findLatestClaudeDesktopBinary();
    if (!latest) {
      logger.warn(
        `Symlink 'claude' di ${linkPath} rusak (Claude Desktop kemungkinan baru auto-update), ` +
          `tapi tidak ditemukan instalasi Claude Desktop lain yang valid untuk diperbaiki otomatis.`
      );
      repaired.push({ path: linkPath, repaired: false, error: "Tidak ada versi Claude Desktop valid ditemukan" });
      continue;
    }

    try {
      fs.unlinkSync(linkPath);
      fs.symlinkSync(latest, linkPath);
      logger.success(
        `Symlink 'claude' di ${linkPath} rusak (Claude Desktop auto-update) - diperbaiki otomatis ke: ${latest}`
      );
      repaired.push({ path: linkPath, repaired: true, target: latest });
    } catch (err) {
      logger.warn(`Gagal memperbaiki symlink 'claude' di ${linkPath}: ${err.message}`);
      repaired.push({ path: linkPath, repaired: false, error: err.message });
    }
  }
  return repaired;
}

module.exports = { checkAndRepairClaudeCliSymlinks };
