const fs = require("fs");
const path = require("path");
const axios = require("axios");
const config = require("../config/config");
const logger = require("../utils/logger");

const GEMINI_BASE = "https://generativelanguage.googleapis.com";

function mimeTypeFor(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".mp3") return "audio/mp3";
  if (ext === ".m4a") return "audio/mp4";
  if (ext === ".ogg") return "audio/ogg";
  if (ext === ".flac") return "audio/flac";
  return "audio/wav";
}

/**
 * Upload file audio ke Gemini File API (bukan inline base64 di body request) - meeting
 * panjang bisa ratusan MB, jauh di atas batas ukuran request inline yang wajar.
 */
async function uploadAudioFile(filePath) {
  const mimeType = mimeTypeFor(filePath);
  const fileSize = fs.statSync(filePath).size;
  const displayName = path.basename(filePath);

  const startRes = await axios.post(
    `${GEMINI_BASE}/upload/v1beta/files?key=${config.gemini.apiKey}`,
    { file: { display_name: displayName } },
    {
      headers: {
        "X-Goog-Upload-Protocol": "resumable",
        "X-Goog-Upload-Command": "start",
        "X-Goog-Upload-Header-Content-Length": fileSize,
        "X-Goog-Upload-Header-Content-Type": mimeType,
        "Content-Type": "application/json",
      },
    }
  );

  const uploadUrl = startRes.headers["x-goog-upload-url"];
  if (!uploadUrl) {
    throw new Error("Gagal memulai upload ke Gemini File API (upload URL tidak diterima).");
  }

  const fileData = fs.readFileSync(filePath);
  const uploadRes = await axios.post(uploadUrl, fileData, {
    headers: {
      "Content-Length": fileSize,
      "X-Goog-Upload-Offset": 0,
      "X-Goog-Upload-Command": "upload, finalize",
    },
    maxBodyLength: Infinity,
    maxContentLength: Infinity,
  });

  return uploadRes.data.file; // { name, uri, mimeType, state, ... }
}

/**
 * Tunggu file selesai diproses server Gemini (state ACTIVE) sebelum dipakai di
 * generateContent - file audio/video butuh waktu diproses dulu di sisi Google.
 */
async function waitForFileActive(fileName, timeoutMs = 180000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const { data } = await axios.get(`${GEMINI_BASE}/v1beta/${fileName}?key=${config.gemini.apiKey}`);
    if (data.state === "ACTIVE") return data;
    if (data.state === "FAILED") throw new Error("Gemini gagal memproses file audio yang diupload.");
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error("Timeout menunggu Gemini selesai memproses file audio.");
}

async function deleteUploadedFile(fileName) {
  try {
    await axios.delete(`${GEMINI_BASE}/v1beta/${fileName}?key=${config.gemini.apiKey}`);
  } catch (e) {
    // Tidak fatal - file yang diupload otomatis expire dalam ~48 jam di sisi Google.
  }
}

/**
 * Transkrip file audio pakai Gemini API (native audio understanding) - alternatif Whisper.
 * Beda dari Whisper: butuh koneksi internet & GEMINI_API_KEY, audio terkirim ke server Google.
 * Kelebihannya: tidak perlu install apapun secara lokal, dan modelnya lumayan kuat untuk
 * audio multi-bahasa/aksen.
 */
async function transcribeWithGemini(audioFilePath) {
  if (!config.gemini.apiKey) {
    throw new Error("GEMINI_API_KEY belum diisi di .env (TRANSCRIBE_PROVIDER=gemini).");
  }
  if (!config.gemini.model) {
    throw new Error(
      "GEMINI_MODEL belum diisi di .env (TRANSCRIBE_PROVIDER=gemini). Cek nama model terbaru di Google AI Studio."
    );
  }

  logger.info("Mengupload audio ke Gemini File API...");
  const uploaded = await uploadAudioFile(audioFilePath);

  logger.info("Menunggu Gemini selesai memproses file audio...");
  await waitForFileActive(uploaded.name);

  logger.info(`Mentranskrip audio pakai Gemini (model: ${config.gemini.model})...`);
  const { data } = await axios.post(
    `${GEMINI_BASE}/v1beta/models/${config.gemini.model}:generateContent?key=${config.gemini.apiKey}`,
    {
      contents: [
        {
          parts: [
            {
              text:
                "Transkrip audio rekaman rapat ini ke teks Bahasa Indonesia secara verbatim " +
                "(apa adanya, JANGAN diterjemahkan atau diringkas). Keluarkan HANYA teks " +
                "transkripnya saja, tanpa timestamp, tanpa penjelasan tambahan.",
            },
            { file_data: { mime_type: uploaded.mimeType, file_uri: uploaded.uri } },
          ],
        },
      ],
    }
  );

  await deleteUploadedFile(uploaded.name);

  const text = data.candidates?.[0]?.content?.parts?.map((p) => p.text).join("\n") || "";
  if (!text.trim()) {
    throw new Error("Gemini tidak mengembalikan teks transkrip (response kosong).");
  }
  return text;
}

module.exports = { transcribeWithGemini };
