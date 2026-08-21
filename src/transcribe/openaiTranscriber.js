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
 * Transkrip file audio pakai OpenAI Audio Transcriptions API (mis. model whisper-1 /
 * gpt-4o-transcribe) - alternatif cloud selain Gemini. Sengaja pakai baseURL/API key
 * TERPISAH dari config `openai.*` yang dipakai SUMMARY_PROVIDER=openai (notulen/teks),
 * karena baseURL notulen sering diarahkan ke server LOKAL yang tidak punya endpoint audio.
 */
async function transcribeWithOpenAi(audioFilePath) {
  if (!config.openai.transcribeApiKey) {
    throw new Error(
      "OPENAI_TRANSCRIBE_API_KEY (atau OPENAI_API_KEY) belum diisi di .env (TRANSCRIBE_PROVIDER=openai)."
    );
  }
  const model = config.openai.transcribeModel;
  logger.info(`Mentranskrip audio pakai OpenAI (model: ${model})...`);

  const fileBuffer = fs.readFileSync(audioFilePath);
  const form = new FormData();
  form.append("file", new Blob([fileBuffer], { type: mimeTypeFor(audioFilePath) }), path.basename(audioFilePath));
  form.append("model", model);
  form.append("language", "id");
  form.append("response_format", "text");

  const base = config.openai.transcribeBaseURL.replace(/\/$/, "");
  const res = await fetch(`${base}/audio/transcriptions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${config.openai.transcribeApiKey}` },
    body: form,
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`OpenAI Audio Transcriptions API gagal (HTTP ${res.status}): ${errText.slice(0, 300)}`);
  }

  const text = await res.text();
  if (!text.trim()) {
    throw new Error("OpenAI tidak mengembalikan teks transkrip (response kosong).");
  }
  return text;
}

module.exports = { transcribeWithOpenAi };
