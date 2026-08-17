const { spawn, spawnSync } = require("child_process");
const path = require("path");
const fs = require("fs");
const os = require("os");
const config = require("../config/config");
const logger = require("../utils/logger");

// State perekaman disimpan di file (bukan hanya in-memory), supaya command
// `meetresult record` (proses A) dan `meetresult stop` (proses B, terpisah)
// tetap bisa saling mengenali/mengontrol proses ffmpeg yang sama.
const STATE_FILE = path.join(config.DATA_DIR, "recording-state.json");

function listDevices() {
  return new Promise((resolve) => {
    const platform = os.platform();
    const args =
      platform === "darwin"
        ? ["-f", "avfoundation", "-list_devices", "true", "-i", ""]
        : platform === "win32"
        ? ["-list_devices", "true", "-f", "dshow", "-i", "dummy"]
        : ["-sources", "pulse"];

    const proc = spawn("ffmpeg", args);
    let output = "";
    proc.stderr.on("data", (d) => (output += d.toString()));
    proc.stdout.on("data", (d) => (output += d.toString()));
    proc.on("close", () => resolve(output));
  });
}

function readState() {
  if (!fs.existsSync(STATE_FILE)) return null;
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf-8"));
  } catch (e) {
    return null;
  }
}

function writeState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), "utf-8");
}

function clearState() {
  if (fs.existsSync(STATE_FILE)) {
    try {
      fs.unlinkSync(STATE_FILE);
    } catch (e) {}
  }
}

function isPidAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return false;
  }
}

function buildCaptureArgs(deviceIndex, outputFile) {
  const platform = os.platform();
  const sampleRate = config.ffmpeg.sampleRate;

  if (platform === "darwin") {
    return ["-y", "-f", "avfoundation", "-i", deviceIndex, "-ar", sampleRate, "-ac", "1", outputFile];
  }
  if (platform === "win32") {
    return ["-y", "-f", "dshow", "-i", `audio=${deviceIndex}`, "-ar", sampleRate, "-ac", "1", outputFile];
  }
  return ["-y", "-f", "pulse", "-i", deviceIndex, "-ar", sampleRate, "-ac", "1", outputFile];
}

function spawnCapture(deviceIndex, outputFile, logFd) {
  const args = buildCaptureArgs(deviceIndex, outputFile);
  const child = spawn("ffmpeg", args, {
    detached: true,
    stdio: ["ignore", logFd, logFd],
  });
  child.unref();
  return child.pid;
}

/**
 * Mulai perekaman.
 *
 * Mode "dual" (default): rekam MIC asli (mic kamu langsung, bukan aggregate) dan
 * SYSTEM audio (BlackHole, menangkap suara lawan bicara via Output/Multi-Output Device)
 * secara PARALEL dalam 2 proses ffmpeg terpisah, lalu digabung saat stop().
 * Ini diperlukan karena Microsoft Teams (dan aplikasi sejenis) tidak bisa memakai
 * Aggregate Device berisi >1 sumber sebagai Microphone - hanya Output/Speaker yang
 * mendukung Aggregate/Multi-Output dengan baik.
 *
 * Mode "single": rekam 1 device saja (perilaku lama).
 */
function startRecording(meetingId, fileNameHint = "meeting") {
  const existing = readState();
  if (existing && ((existing.pid && isPidAlive(existing.pid)) || (existing.pids && Object.values(existing.pids).some(isPidAlive)))) {
    throw new Error(
      `Sudah ada perekaman aktif untuk meeting ${existing.meetingId}. Hentikan dulu dengan 'meetresult stop'.`
    );
  }

  const safeName = fileNameHint.replace(/[^a-zA-Z0-9-_]/g, "_");
  const ts = Date.now();
  const logFile = path.join(config.DATA_DIR, "ffmpeg-recording.log");
  const logFd = fs.openSync(logFile, "a");

  if (config.ffmpeg.mode === "dual") {
    const micFile = path.join(config.RECORDINGS_DIR, `${ts}_${safeName}_mic.wav`);
    const systemFile = path.join(config.RECORDINGS_DIR, `${ts}_${safeName}_system.wav`);
    const finalFile = path.join(config.RECORDINGS_DIR, `${ts}_${safeName}.wav`);

    logger.info(`Memulai perekaman dual-device:`);
    logger.info(`  Mic (index ${config.ffmpeg.micDeviceIndex}): ${micFile}`);
    logger.info(`  System/BlackHole (index ${config.ffmpeg.systemDeviceIndex}): ${systemFile}`);

    const micPid = spawnCapture(config.ffmpeg.micDeviceIndex, micFile, logFd);
    const systemPid = spawnCapture(config.ffmpeg.systemDeviceIndex, systemFile, logFd);

    writeState({
      mode: "dual",
      meetingId,
      pids: { mic: micPid, system: systemPid },
      tempFiles: { mic: micFile, system: systemFile },
      finalAudioFile: finalFile,
      startedAt: new Date().toISOString(),
    });

    return finalFile;
  }

  // Mode single (legacy)
  const outputFile = path.join(config.RECORDINGS_DIR, `${ts}_${safeName}.wav`);
  logger.info(`Memulai perekaman audio: ${outputFile}`);
  const pid = spawnCapture(config.ffmpeg.deviceIndex, outputFile, logFd);

  writeState({
    mode: "single",
    meetingId,
    pid,
    audioFile: outputFile,
    startedAt: new Date().toISOString(),
  });

  return outputFile;
}

/**
 * Gabungkan 2 file audio (mic + system) jadi 1 file mono memakai ffmpeg amix.
 * Menghapus file sementara setelah berhasil digabung.
 */
function mergeAudioFiles(micFile, systemFile, outputFile) {
  const args = [
    "-y",
    "-i",
    micFile,
    "-i",
    systemFile,
    "-filter_complex",
    "amix=inputs=2:duration=longest:dropout_transition=0,dynaudnorm",
    "-ar",
    config.ffmpeg.sampleRate,
    "-ac",
    "1",
    outputFile,
  ];
  const result = spawnSync("ffmpeg", args, { stdio: "ignore" });
  if (result.status !== 0) {
    throw new Error(`Gagal menggabungkan audio mic+system (kode ${result.status})`);
  }
  [micFile, systemFile].forEach((f) => {
    try {
      if (fs.existsSync(f)) fs.unlinkSync(f);
    } catch (e) {}
  });
  return outputFile;
}

/**
 * Kirim sinyal stop ke proses ffmpeg yang berjalan (dual atau single), lalu
 * hapus state file. TIDAK menunggu proses benar-benar selesai/gabung -
 * gunakan `finalizeRecording()` (async) setelah ini untuk itu.
 *
 * Return: state lengkap (sebelum dihapus) yang dibutuhkan `finalizeRecording()`,
 * atau null kalau memang tidak ada perekaman aktif.
 */
function stopRecording() {
  const state = readState();
  if (!state) {
    logger.warn("Tidak ada perekaman yang sedang berjalan.");
    return null;
  }

  if (state.mode === "dual") {
    const { mic, system } = state.pids || {};
    const anyAlive = isPidAlive(mic) || isPidAlive(system);
    if (!anyAlive) {
      logger.warn("Tidak ada perekaman yang sedang berjalan.");
      clearState();
      return null;
    }
    [mic, system].forEach((pid) => {
      if (isPidAlive(pid)) {
        try {
          process.kill(pid, "SIGINT");
        } catch (e) {}
      }
    });
    clearState();
    logger.success("Perintah stop dikirim ke kedua proses ffmpeg (mic & system).");
    return state;
  }

  // Mode single (legacy)
  if (!isPidAlive(state.pid)) {
    logger.warn("Tidak ada perekaman yang sedang berjalan.");
    clearState();
    return null;
  }
  try {
    process.kill(state.pid, "SIGINT");
  } catch (e) {
    logger.warn(`Gagal mengirim sinyal stop ke ffmpeg: ${e.message}`);
  }
  clearState();
  logger.success("Perintah stop dikirim ke ffmpeg.");
  return state;
}

function waitForPidExit(pid, timeoutMs = 15000, intervalMs = 300) {
  return new Promise((resolve) => {
    if (!isPidAlive(pid)) return resolve(true);
    const start = Date.now();
    const timer = setInterval(() => {
      if (!isPidAlive(pid) || Date.now() - start > timeoutMs) {
        clearInterval(timer);
        resolve(true);
      }
    }, intervalMs);
  });
}

/**
 * Tunggu proses ffmpeg benar-benar berhenti (tidak pakai delay tetap - supaya
 * aman untuk rekaman panjang), lalu gabungkan mic+system kalau mode "dual".
 * Panggil ini SETELAH `stopRecording()`, dengan state yang dikembalikannya.
 *
 * Return: path file audio final yang siap ditranskrip.
 */
async function finalizeRecording(state) {
  if (!state) return null;

  if (state.mode === "dual") {
    const { mic, system } = state.pids || {};
    await Promise.all([waitForPidExit(mic), waitForPidExit(system)]);
    logger.info("Menggabungkan audio mic + system...");
    mergeAudioFiles(state.tempFiles.mic, state.tempFiles.system, state.finalAudioFile);
    logger.success(`Audio berhasil digabung: ${state.finalAudioFile}`);
    return state.finalAudioFile;
  }

  // Mode single
  await waitForPidExit(state.pid);
  return state.audioFile;
}

function isRecording() {
  const state = readState();
  if (!state) return false;
  if (state.mode === "dual") {
    return !!(state.pids && Object.values(state.pids).some(isPidAlive));
  }
  return isPidAlive(state.pid);
}

function getActiveMeetingId() {
  const state = readState();
  return state ? state.meetingId : null;
}

module.exports = {
  startRecording,
  stopRecording,
  finalizeRecording,
  isRecording,
  getActiveMeetingId,
  listDevices,
  mergeAudioFiles,
};
