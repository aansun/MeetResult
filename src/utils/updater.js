const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");
const axios = require("axios");
const config = require("../config/config");
const logger = require("./logger");

const REPO_OWNER = "aansun";
const REPO_NAME = "MeetResult";
const REPO_URL = `https://github.com/${REPO_OWNER}/${REPO_NAME}.git`;
const RAW_PACKAGE_JSON_URLS = [
  `https://raw.githubusercontent.com/${REPO_OWNER}/${REPO_NAME}/main/package.json`,
  `https://raw.githubusercontent.com/${REPO_OWNER}/${REPO_NAME}/master/package.json`,
];

function getLocalVersion() {
  const pkg = JSON.parse(
    fs.readFileSync(path.join(config.ROOT_DIR, "package.json"), "utf-8")
  );
  return pkg.version;
}

function isGitRepo() {
  return fs.existsSync(path.join(config.ROOT_DIR, ".git"));
}

function run(cmd) {
  return execSync(cmd, { cwd: config.ROOT_DIR, stdio: ["ignore", "pipe", "ignore"] })
    .toString()
    .trim();
}

/**
 * Cek update lewat git (kalau project ini adalah clone dari repo GitHub).
 * Membandingkan HEAD lokal vs HEAD branch yang sama di remote "origin".
 */
async function checkViaGit() {
  run("git fetch origin --quiet");
  const branch = run("git rev-parse --abbrev-ref HEAD");
  const localHead = run("git rev-parse HEAD");
  let remoteHead;
  try {
    remoteHead = run(`git rev-parse origin/${branch}`);
  } catch (e) {
    // Branch lokal tidak ada di remote (mis. branch kerja sendiri) -> coba main/master
    try {
      remoteHead = run("git rev-parse origin/main");
    } catch (e2) {
      remoteHead = run("git rev-parse origin/master");
    }
  }

  const behindCount = (() => {
    try {
      return Number(run(`git rev-list --count HEAD..origin/${branch}`));
    } catch (e) {
      return localHead !== remoteHead ? 1 : 0;
    }
  })();

  return {
    method: "git",
    hasUpdate: localHead !== remoteHead && behindCount > 0,
    localVersion: getLocalVersion(),
    detail:
      localHead !== remoteHead && behindCount > 0
        ? `Ada ${behindCount} commit baru di remote (origin/${branch}).`
        : "Sudah versi terbaru.",
  };
}

/**
 * Fallback: cek update lewat GitHub raw content (package.json di branch default),
 * dipakai kalau project TIDAK di-clone via git (mis. hasil download/extract manual).
 */
async function checkViaGithubApi() {
  let remotePkg = null;
  let lastError = null;

  for (const url of RAW_PACKAGE_JSON_URLS) {
    try {
      const { data } = await axios.get(url, { timeout: 8000 });
      remotePkg = typeof data === "string" ? JSON.parse(data) : data;
      break;
    } catch (e) {
      lastError = e;
    }
  }

  if (!remotePkg) {
    throw new Error(
      `Gagal mengambil info versi dari GitHub. Periksa koneksi internet atau cek manual: ${REPO_URL} (${lastError?.message || ""})`
    );
  }

  const localVersion = getLocalVersion();
  const hasUpdate = compareVersions(remotePkg.version, localVersion) > 0;

  return {
    method: "api",
    hasUpdate,
    localVersion,
    remoteVersion: remotePkg.version,
    detail: hasUpdate
      ? `Versi baru tersedia: v${remotePkg.version} (kamu pakai v${localVersion}).`
      : "Sudah versi terbaru.",
  };
}

/**
 * Bandingkan 2 versi semver sederhana (mis. "1.2.0" vs "1.10.0").
 * Return: 1 kalau a > b, -1 kalau a < b, 0 kalau sama.
 */
function compareVersions(a, b) {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const na = pa[i] || 0;
    const nb = pb[i] || 0;
    if (na > nb) return 1;
    if (na < nb) return -1;
  }
  return 0;
}

/**
 * Cek apakah ada update terbaru di GitHub repo MeetResult.
 */
async function checkForUpdates() {
  if (isGitRepo()) {
    try {
      return await checkViaGit();
    } catch (e) {
      logger.warn(`Cek update via git gagal (${e.message}), coba via GitHub API...`);
    }
  }
  return checkViaGithubApi();
}

/**
 * Terapkan update: git pull + npm install (hanya berjalan kalau project berupa git repo).
 */
async function applyUpdate() {
  if (!isGitRepo()) {
    throw new Error(
      `Project ini bukan git clone, tidak bisa auto-update. Silakan download ulang manual dari ${REPO_URL}`
    );
  }
  logger.info("Menjalankan git pull...");
  console.log(run("git pull"));
  logger.info("Menjalankan npm install (update dependency)...");
  execSync("npm install", { cwd: config.ROOT_DIR, stdio: "inherit" });
  logger.success("Update selesai diterapkan.");
}

module.exports = { checkForUpdates, applyUpdate, getLocalVersion, REPO_URL, isGitRepo };
