const axios = require("axios");
const config = require("../config/config");

/**
 * Panggil 9Router (https://github.com/decolua/9router) - gateway OpenAI-compatible lokal/
 * remote untuk banyak provider AI sekaligus, lewat endpoint Chat Completions resminya
 * (POST /v1/chat/completions). TERPISAH dari config `ninerouterTranscribe` (dipakai
 * TRANSCRIBE_PROVIDER=ninerouter) walau sama-sama 9Router, supaya konfigurasi kedua peran
 * (URL/API key/model) tidak tertukar - 9Router sendiri punya daftar model TERPISAH untuk
 * chat (/v1/models) vs speech-to-text (/v1/models/stt).
 */
async function askNinerouter(systemPrompt, userPrompt) {
  if (!config.ninerouter.url) {
    throw new Error("NINEROUTER_URL belum diisi di .env (SUMMARY_PROVIDER=ninerouter).");
  }
  if (!config.ninerouter.model) {
    throw new Error(
      'NINEROUTER_MODEL belum diisi di .env (SUMMARY_PROVIDER=ninerouter). Format "provider/model", cek pilihan lewat GET <NINEROUTER_URL>/v1/models.'
    );
  }

  const baseURL = config.ninerouter.url.replace(/\/+$/, "");
  const headers = { "content-type": "application/json" };
  if (config.ninerouter.apiKey) {
    headers.Authorization = `Bearer ${config.ninerouter.apiKey}`;
  }

  try {
    const { data } = await axios.post(
      `${baseURL}/v1/chat/completions`,
      {
        model: config.ninerouter.model,
        temperature: 0.2,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
      },
      { headers }
    );

    const text = data.choices?.[0]?.message?.content;
    if (!text) {
      throw new Error("Response tidak berisi konten (choices[0].message.content kosong).");
    }
    return text;
  } catch (err) {
    if (err.response) {
      throw new Error(
        `9Router (${baseURL}) error ${err.response.status}: ${JSON.stringify(err.response.data)}`
      );
    }
    throw new Error(`Gagal menghubungi 9Router di ${baseURL}: ${err.message}`);
  }
}

module.exports = { askNinerouter };
