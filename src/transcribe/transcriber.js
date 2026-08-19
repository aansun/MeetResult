const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const config = require("../config/config");
const logger = require("../utils/logger");
const { monthSubdir } = require("../utils/filename");

/**
 * Menjalankan Whisper untuk mentranskrip file audio hasil rekaman menjadi teks Bahasa Indonesia.
 *
 * Rekomendasi (default): `whisper-ctranslate2` (pip3 install -U whisper-ctranslate2)
 *   - Ringan (tanpa PyTorch), cepat, cocok untuk Apple Silicon.
 * Alternatif: `whisper` (openai-whisper asli, lebih berat, butuh flag --fp16).
 */
function transcribeAudio(audioFilePath) {
  return new Promise((resolve, reject) => {
    if (!fs.existsSync(audioFilePath)) {
      return reject(new Error(`File audio tidak ditemukan: ${audioFilePath}`));
    }

    // Kelompokkan transkrip per bulan berdasarkan tanggal rekaman (mtime file audio) -
    // supaya data/transcripts/ tidak menumpuk jadi 1 folder besar seiring waktu.
    const outDir = monthSubdir(config.TRANSCRIPTS_DIR, fs.statSync(audioFilePath).mtime);
    const isClassicWhisper = /(^|\/)whisper$/.test(config.whisper.bin);

    const args = [
      audioFilePath,
      "--model",
      config.whisper.model,
      "--language",
      config.whisper.language, // "id" untuk Bahasa Indonesia
      "--task",
      "transcribe",
      "--output_format",
      "txt",
      "--output_dir",
      outDir,
    ];

    // Flag --fp16 hanya dikenali oleh openai-whisper asli, bukan whisper-ctranslate2
    if (isClassicWhisper) {
      args.push("--fp16", "False");
    } else {
      // Optimasi khusus whisper-ctranslate2 untuk audio panjang (mis. meeting 2+ jam):
      // - batched: percepat 2-4x (proses beberapa segmen paralel dalam 1 model)
      // - vad_filter: skip bagian hening/silence -> lebih cepat & kurangi halusinasi teks
      if (config.whisper.batched) {
        args.push("--batched", "True", "--batch_size", String(config.whisper.batchSize));
      }
      if (config.whisper.vadFilter) {
        args.push("--vad_filter", "True");
      }
    }

    logger.info(
      `Menjalankan transkripsi Whisper (model=${config.whisper.model}, bahasa=${config.whisper.language}, batched=${config.whisper.batched}, vad=${config.whisper.vadFilter})...`
    );

    const proc = spawn(config.whisper.bin, args);

    proc.stdout.on("data", (d) => process.stdout.write(d));
    proc.stderr.on("data", (d) => process.stdout.write(d));

    proc.on("error", (err) => {
      reject(
        new Error(
          `Gagal menjalankan Whisper ('${config.whisper.bin}'). Pastikan sudah terinstall: ` +
            `pip3 install -U whisper-ctranslate2. Detail: ${err.message}`
        )
      );
    });

    proc.on("close", (code) => {
      if (code !== 0) {
        return reject(new Error(`Whisper keluar dengan kode error ${code}`));
      }
      const base = path.basename(audioFilePath, path.extname(audioFilePath));
      const transcriptFile = path.join(outDir, `${base}.txt`);
      if (!fs.existsSync(transcriptFile)) {
        return reject(
          new Error(`Transkrip tidak ditemukan di ${transcriptFile}`)
        );
      }
      logger.success(`Transkrip selesai: ${transcriptFile}`);
      resolve(transcriptFile);
    });
  });
}

module.exports = { transcribeAudio };
