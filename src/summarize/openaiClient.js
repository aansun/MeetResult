const axios = require("axios");
const config = require("../config/config");

/**
 * Panggil endpoint Chat Completions yang OpenAI-compatible (/v1/chat/completions).
 * OPENAI_BASE_URL bisa diarahkan ke OpenAI cloud ATAU server LOKAL (Ollama, MLX/mlx-omni-server,
 * LM Studio, vLLM, dll) yang mengimplementasikan API yang sama - jadi 1 client ini otomatis
 * berfungsi untuk kedua mode (cloud/local) tanpa kode terpisah.
 */
async function askOpenAi(systemPrompt, userPrompt) {
  const baseURL = (config.openai.baseURL || "https://api.openai.com/v1").replace(/\/+$/, "");

  if (!config.openai.model) {
    throw new Error(
      "OPENAI_MODEL belum diisi di .env (SUMMARY_PROVIDER=openai). Isi nama model dari provider/server yang dipakai."
    );
  }

  const headers = { "content-type": "application/json" };
  if (config.openai.apiKey) {
    headers.Authorization = `Bearer ${config.openai.apiKey}`;
  }

  try {
    const { data } = await axios.post(
      `${baseURL}/chat/completions`,
      {
        model: config.openai.model,
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
        `OpenAI-compatible API (${baseURL}) error ${err.response.status}: ${JSON.stringify(
          err.response.data
        )}`
      );
    }
    throw new Error(`Gagal menghubungi OpenAI-compatible API di ${baseURL}: ${err.message}`);
  }
}

module.exports = { askOpenAi };
