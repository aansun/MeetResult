const http = require("http");
const fs = require("fs");
const path = require("path");
const os = require("os");

// Server AI lokal yang OpenAI-compatible & umum dipakai, dicek berurutan lewat port default-nya.
// Ollama & LM Studio umumnya tidak butuh API key. oMLX (khusus macOS/Apple Silicon) dicek
// terpisah lewat detectOmlx() karena port-nya bisa dikustomisasi user & selalu butuh API key -
// keduanya dibaca langsung dari file config aslinya (~/.omlx/settings.json).
const CANDIDATES = [
  { name: "Ollama", baseURL: "http://localhost:11434/v1" },
  { name: "LM Studio", baseURL: "http://localhost:1234/v1" },
];

const OMLX_SETTINGS_PATH = path.join(os.homedir(), ".omlx", "settings.json");

function fetchJson(url, { timeoutMs = 800, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { timeout: timeoutMs, headers }, (res) => {
      let body = "";
      res.on("data", (d) => (body += d));
      res.on("end", () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try {
            resolve(JSON.parse(body));
          } catch (e) {
            reject(e);
          }
        } else {
          reject(new Error(`HTTP ${res.statusCode}`));
        }
      });
    });
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", reject);
  });
}

function firstModelId(data) {
  const models = data?.data || data?.models || [];
  return (Array.isArray(models) && models[0] && (models[0].id || models[0].name)) || "";
}

/**
 * Cek aplikasi oMLX (server MLX lokal untuk Apple Silicon, https://omlx.app) lewat file
 * konfigurasi aslinya di ~/.omlx/settings.json - berisi host/port yang dipakai (bisa
 * dikustomisasi user) dan API key yang WAJIB (oMLX selalu butuh Bearer token, beda dari
 * Ollama/LM Studio yang biasanya terbuka tanpa auth).
 */
async function detectOmlx() {
  if (!fs.existsSync(OMLX_SETTINGS_PATH)) return null;

  let settings;
  try {
    settings = JSON.parse(fs.readFileSync(OMLX_SETTINGS_PATH, "utf-8"));
  } catch (e) {
    return null;
  }

  const port = settings?.server?.port;
  const apiKey = settings?.auth?.api_key;
  if (!port || !apiKey) return null;

  const baseURL = `http://127.0.0.1:${port}/v1`;
  try {
    const data = await fetchJson(`${baseURL}/models`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    return { name: "oMLX", baseURL, apiKey, model: firstModelId(data) };
  } catch (e) {
    return null; // oMLX terinstall tapi server-nya sedang tidak aktif
  }
}

/**
 * Cek apakah ada server AI lokal (OpenAI-compatible) yang sedang aktif - oMLX, Ollama, atau
 * LM Studio - lalu kembalikan base URL (+ API key & model kalau ada) untuk auto-konfigurasi
 * provider "openai" ke server lokal (privasi & gratis) tanpa user perlu isi manual.
 */
async function detectLocalAiServer() {
  const omlx = await detectOmlx();
  if (omlx) return omlx;

  for (const c of CANDIDATES) {
    try {
      const data = await fetchJson(`${c.baseURL}/models`);
      return { name: c.name, baseURL: c.baseURL, model: firstModelId(data) };
    } catch (e) {
      // Server ini tidak hidup di port default-nya - lanjut cek kandidat berikutnya
    }
  }
  return null;
}

module.exports = { detectLocalAiServer, CANDIDATES };
