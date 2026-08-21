const { spawn, spawnSync } = require("child_process");

// Cek status pakai `local_files_only=True` milik faster-whisper sendiri - ini persis fungsi
// yang dipanggil whisper-ctranslate2 di belakang layar untuk resolve model, jadi hasilnya
// selalu konsisten dengan behaviour transkripsi nyata (tidak menebak lokasi cache manual).
const STATUS_SCRIPT = `
import sys, json
try:
    from faster_whisper.utils import download_model
    path = download_model(sys.argv[1], local_files_only=True)
    print(json.dumps({"cached": True, "path": path}))
except Exception as e:
    print(json.dumps({"cached": False, "error": str(e)}))
`;

const DOWNLOAD_SCRIPT = `
import sys
from faster_whisper.utils import download_model
download_model(sys.argv[1])
print("MEETRESULT_DOWNLOAD_DONE")
`;

/**
 * Cek apakah model Whisper tertentu sudah ada di cache lokal (~/.cache/huggingface).
 * Return: { cached: boolean, path?: string, error?: string }
 */
function checkWhisperModelCached(model) {
  const result = spawnSync("python3", ["-c", STATUS_SCRIPT, model], { encoding: "utf-8" });
  try {
    return JSON.parse((result.stdout || "").trim());
  } catch (e) {
    return {
      cached: false,
      error: (result.stderr || "").trim() || "Gagal cek status model (python3/faster-whisper tidak ditemukan).",
    };
  }
}

/**
 * Unduh model Whisper ke cache lokal. `onOutput` dipanggil tiap ada output baru (stdout/
 * stderr digabung - huggingface_hub menulis progress bar unduhan ke stderr).
 */
function downloadWhisperModel(model, onOutput) {
  return new Promise((resolve, reject) => {
    const proc = spawn("python3", ["-c", DOWNLOAD_SCRIPT, model]);
    proc.stdout.on("data", (d) => onOutput && onOutput(d.toString()));
    proc.stderr.on("data", (d) => onOutput && onOutput(d.toString()));
    proc.on("error", (err) => reject(new Error(`Gagal menjalankan python3: ${err.message}`)));
    proc.on("close", (code) => {
      if (code !== 0) return reject(new Error(`Gagal mengunduh model '${model}' (kode keluar ${code}).`));
      resolve();
    });
  });
}

module.exports = { checkWhisperModelCached, downloadWhisperModel };
