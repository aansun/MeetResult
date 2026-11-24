const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const config = require("../config/config");

/**
 * Semua executable `name` yang ada di PATH proses ini, urut sesuai prioritas PATH (yang pertama
 * adalah yang benar-benar dijalankan `spawn("claude")`). Tiap entri: path, realpath, versi.
 */
function findOnPath(name) {
  const seen = new Set();
  const found = [];
  for (const dir of (process.env.PATH || "").split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, name);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      const real = fs.realpathSync(candidate);
      if (seen.has(real)) continue;
      seen.add(real);
      found.push({ path: candidate, real });
    } catch (e) {}
  }
  return found;
}

function versionOf(binPath) {
  try {
    const r = spawnSync(binPath, ["--version"], { encoding: "utf-8", timeout: 8000 });
    return (r.stdout || "").trim().split("\n")[0] || null;
  } catch (e) {
    return null;
  }
}

/** Path absolut binary claude yang akan dipakai (CLAUDE_CLI_BIN kalau absolut, atau hit PATH pertama). */
function resolveClaudeBinary() {
  const configured = config.claude.cliBin;
  if (path.isAbsolute(configured)) return configured;
  const hits = findOnPath(configured);
  return hits.length ? hits[0].path : null;
}

/**
 * Cek apakah ada >1 instalasi `claude` BERBEDA di PATH (mis. versi standalone di ~/.local/bin
 * dan versi bawaan Claude Desktop di /opt/homebrew/bin). Keduanya berbagi kredensial yang sama
 * di Keychain - login/refresh dari salah satu bisa membatalkan token yang lain, penyebab sesi
 * "OAuth session expired" yang berulang. Return null kalau aman.
 */
function inspectClaudeInstallations() {
  const hits = findOnPath(path.basename(config.claude.cliBin));
  const used = resolveClaudeBinary();
  const withVersion = hits.map((h) => ({ ...h, version: versionOf(h.path) }));
  const duplicate = withVersion.length > 1;
  return {
    used,
    installations: withVersion,
    duplicate,
    warning: duplicate
      ? `Ada ${withVersion.length} instalasi 'claude' berbeda di PATH (${withVersion
          .map((h) => `${h.path} v${h.version || "?"}`)
          .join(" | ")}). Watcher memakai: ${used}. Kredensial dipakai bersama sehingga bisa saling membatalkan login - ` +
        `hapus salah satu, atau pastikan login dilakukan dengan binary yang dipakai watcher ('${used} login').`
      : null,
  };
}

module.exports = { resolveClaudeBinary, inspectClaudeInstallations, findOnPath };
