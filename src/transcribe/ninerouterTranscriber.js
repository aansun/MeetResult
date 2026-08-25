const fs = require("fs");
const path = require("path");
const config = require("../config/config");
const logger = require("../utils/logger");

function mimeTypeFor(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".mp3") return "audio/mpeg";
  if (ext === ".m4a") return "audio/mp4";
  if (ext === ".ogg") return "audio/ogg";
  if (ext === ".flac") return "audio/flac";
  return "audio/wav";
}

/**
 * Transkrip file audio lewat 9Router (https://github.com/decolua/9router), endpoint resmi
 * POST /v1/audio/transcriptions (bentuk OpenAI Whisper-compatible, response default JSON
 * `{text: "..."}`). Model WAJIB salah satu dari daftar KHUSUS speech-to-text 9Router (GET
 * /v1/models/stt) - BUKAN daftar model chat biasa (/v1/models) yang dipakai provider
 * "ninerouter" untuk NOTULEN, makanya config `ninerouterTranscribe.*` sengaja terpisah dari
 * `ninerouter.*` (lihat ninerouterClient.js).
 */
async function transcribeWithNinerouter(audioFilePath) {
  const { url, apiKey, model } = config.ninerouterTranscribe;
  if (!url) {
    throw new Error("NINEROUTER_TRANSCRIBE_URL belum diisi di .env (TRANSCRIBE_PROVIDER=ninerouter).");
  }
  if (!model) {
    throw new Error(
      'NINEROUTER_TRANSCRIBE_MODEL belum diisi di .env (TRANSCRIBE_PROVIDER=ninerouter). Format "provider/model", cek pilihan lewat GET <NINEROUTER_TRANSCRIBE_URL>/v1/models/stt.'
    );
  }
  logger.info(`Mentranskrip audio pakai 9Router (model: ${model})...`);

  const fileBuffer = fs.readFileSync(audioFilePath);
  const form = new FormData();
  form.append("file", new Blob([fileBuffer], { type: mimeTypeFor(audioFilePath) }), path.basename(audioFilePath));
  form.append("model", model);
  form.append("language", "id");
  form.append("response_format", "json");

  const base = url.replace(/\/+$/, "");
  const headers = {};
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

  const res = await fetch(`${base}/v1/audio/transcriptions`, {
    method: "POST",
    headers,
    body: form,
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`9Router Audio Transcriptions gagal (HTTP ${res.status}): ${errText.slice(0, 300)}`);
  }

  const data = await res.json();
  const text = data.text;
  if (!text || !text.trim()) {
    throw new Error("9Router tidak mengembalikan teks transkrip (response kosong).");
  }
  return text;
}

module.exports = { transcribeWithNinerouter };
