const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const config = require("../config/config");
const logger = require("../utils/logger");
const { monthSubdir } = require("../utils/filename");
const { transcribeWithGemini } = require("./geminiTranscriber");
const { transcribeWithOpenAi } = require("./openaiTranscriber");

/**
 * Menjalankan Whisper untuk mentranskrip file audio hasil rekaman menjadi teks Bahasa Indonesia.
 *
 * Rekomendasi (default): `whisper-ctranslate2` (pip3 install -U whisper-ctranslate2)
 *   - Ringan (tanpa PyTorch), cepat, cocok untuk Apple Silicon.
 * Alternatif: `whisper` (openai-whisper asli, lebih berat, butuh flag --fp16).
 */
function transcribeWithWhisper(audioFilePath, outDir, modelOverride) {
  return new Promise((resolve, reject) => {
    const isClassicWhisper = /(^|\/)whisper$/.test(config.whisper.bin);
    const model = modelOverride || config.whisper.model;

    const args = [
      audioFilePath,
      "--model",
      model,
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

    // Bantu Whisper mengenali istilah/nama yang sering salah transkrip (mis. nama tokoh,
    // istilah Arab) - Whisper akurat untuk kalimat umum tapi lemah untuk kosakata spesifik
    // tanpa hint ini.
    if (config.whisper.hotwords) {
      args.push("--hotwords", config.whisper.hotwords);
    }
    if (config.whisper.initialPrompt) {
      args.push("--initial_prompt", config.whisper.initialPrompt);
    }

    logger.info(
      `Menjalankan transkripsi Whisper (model=${model}, bahasa=${config.whisper.language}, batched=${config.whisper.batched}, vad=${config.whisper.vadFilter})...`
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
        return reject(new Error(`Transkrip tidak ditemukan di ${transcriptFile}`));
      }
      logger.success(`Transkrip selesai: ${transcriptFile}`);
      resolve(transcriptFile);
    });
  });
}

/**
 * Transkrip pakai provider cloud (Gemini/OpenAI) - hasil teksnya ditulis manual ke file,
 * mengikuti konvensi nama & folder bulanan yang sama seperti jalur Whisper, supaya langkah
 * berikutnya (summarizer) tidak perlu tahu provider transkripsi mana yang dipakai.
 */
async function transcribeWithCloudToFile(audioFilePath, outDir, transcribeFn) {
  const base = path.basename(audioFilePath, path.extname(audioFilePath));
  const transcriptFile = path.join(outDir, `${base}.txt`);

  const text = await transcribeFn(audioFilePath);
  fs.writeFileSync(transcriptFile, text, "utf-8");
  logger.success(`Transkrip selesai: ${transcriptFile}`);
  return transcriptFile;
}

/**
 * Transkrip lewat SATU provider tertentu (bukan cuma yang lagi aktif di config) - dipisah
 * supaya bisa dipakai ulang untuk provider fallback (lihat transcribeAudio() di bawah).
 * `whisperModelOverride` dipakai supaya fallback Whisper bisa pakai model BERBEDA dari
 * WHISPER_MODEL biasa (mis. model lebih kecil/cepat khusus untuk skenario darurat fallback).
 */
async function transcribeWithProvider(providerName, audioFilePath, outDir, whisperModelOverride) {
  if (providerName === "gemini") {
    return transcribeWithCloudToFile(audioFilePath, outDir, transcribeWithGemini);
  }
  if (providerName === "openai") {
    return transcribeWithCloudToFile(audioFilePath, outDir, transcribeWithOpenAi);
  }
  return transcribeWithWhisper(audioFilePath, outDir, whisperModelOverride);
}

/**
 * Transkrip file audio jadi teks - dispatch ke Whisper (default, lokal/offline), Gemini
 * (TRANSCRIBE_PROVIDER=gemini, cloud, butuh GEMINI_API_KEY), atau OpenAI (TRANSCRIBE_PROVIDER=
 * openai, cloud, butuh OPENAI_API_KEY, endpoint Audio Transcriptions).
 *
 * Kalau provider utama gagal (error teknis, kuota habis, dll) DAN TRANSCRIBE_FALLBACK_PROVIDER
 * diisi, otomatis dicoba ulang lewat provider fallback tersebut - rekomendasi: pakai "whisper"
 * (lokal) sebagai fallback kalau provider utama cloud (gemini/openai), supaya transkripsi
 * TETAP berhasil walau cloud sedang down atau kuota habis.
 */
async function transcribeAudio(audioFilePath) {
  if (!fs.existsSync(audioFilePath)) {
    throw new Error(`File audio tidak ditemukan: ${audioFilePath}`);
  }

  // Kelompokkan transkrip per bulan berdasarkan tanggal rekaman (mtime file audio) -
  // supaya data/transcripts/ tidak menumpuk jadi 1 folder besar seiring waktu.
  const outDir = monthSubdir(config.TRANSCRIPTS_DIR, fs.statSync(audioFilePath).mtime);
  const primary = config.transcribe.provider;

  try {
    return await transcribeWithProvider(primary, audioFilePath, outDir);
  } catch (err) {
    const fallback = config.transcribe.fallbackProvider;
    if (!fallback || fallback === primary) throw err;

    logger.warn(`Transkripsi via '${primary}' gagal (${err.message}) - mencoba fallback '${fallback}'...`);
    try {
      const fallbackWhisperModel = fallback === "whisper" ? config.whisper.fallbackModel : undefined;
      return await transcribeWithProvider(fallback, audioFilePath, outDir, fallbackWhisperModel);
    } catch (fallbackErr) {
      throw new Error(
        `Transkripsi gagal di provider utama ('${primary}': ${err.message}) DAN fallback ('${fallback}': ${fallbackErr.message}).`
      );
    }
  }
}

module.exports = { transcribeAudio };
