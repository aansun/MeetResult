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
 * Transkrip file audio lewat server CUSTOM/LOKAL yang expose endpoint OpenAI Audio
 * Transcriptions-compatible (POST /audio/transcriptions) - TERPISAH dari provider "openai"
 * (OpenAI cloud resmi, lihat openaiTranscriber.js) supaya base URL/API key/model keduanya
 * tidak tertukar. Kedua provider ini boleh aktif sekaligus dengan konfigurasi beda (mis. satu
 * jadi provider utama, satu lagi jadi fallback).
 */
async function transcribeWithOpenAiCompatible(audioFilePath) {
  const { baseURL, apiKey, model } = config.openaiCompatibleTranscribe;
  if (!baseURL) {
    throw new Error(
      "OPENAI_COMPATIBLE_TRANSCRIBE_BASE_URL belum diisi di .env (TRANSCRIBE_PROVIDER=openai-compatible)."
    );
  }
  logger.info(`Mentranskrip audio pakai endpoint OpenAI-compatible custom (model: ${model || "(default server)"})...`);

  const fileBuffer = fs.readFileSync(audioFilePath);
  const form = new FormData();
  form.append("file", new Blob([fileBuffer], { type: mimeTypeFor(audioFilePath) }), path.basename(audioFilePath));
  if (model) form.append("model", model);
  form.append("language", "id");
  form.append("response_format", "text");

  const base = baseURL.replace(/\/+$/, "");
  const headers = {};
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

  const res = await fetch(`${base}/audio/transcriptions`, {
    method: "POST",
    headers,
    body: form,
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`Endpoint OpenAI-compatible custom gagal (HTTP ${res.status}): ${errText.slice(0, 300)}`);
  }

  // Server custom kadang tetap balas JSON walau response_format=text diminta (deviasi umum
  // pada implementasi non-OpenAI) - deteksi lewat content-type & ambil field "text"-nya.
  const responseText = await res.text();
  let text = responseText;
  if ((res.headers.get("content-type") || "").includes("application/json")) {
    try {
      const data = JSON.parse(responseText);
      if (typeof data.text === "string") text = data.text;
    } catch (err) {}
  }
  if (!text.trim()) {
    throw new Error("Endpoint OpenAI-compatible custom tidak mengembalikan teks transkrip (response kosong).");
  }
  return text;
}

module.exports = { transcribeWithOpenAiCompatible };
