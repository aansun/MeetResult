const fs = require("fs");
const path = require("path");
const { detectLocalAiServer } = require("./localAiDetect");

const ROOT_DIR = path.resolve(__dirname, "..", "..");
const ENV_PATH = path.join(ROOT_DIR, ".env");
const ENV_EXAMPLE_PATH = path.join(ROOT_DIR, ".env.example");

function readEnvValue(content, key) {
  const m = content.match(new RegExp(`^${key}=(.*)$`, "m"));
  return m ? m[1].trim() : "";
}

function setEnvValue(content, key, value) {
  const re = new RegExp(`^${key}=.*$`, "m");
  if (re.test(content)) {
    return content.replace(re, `${key}=${value}`);
  }
  return content.replace(/\n?$/, `\n${key}=${value}\n`);
}

/**
 * Auto-deteksi server AI lokal (Ollama/MLX/LM Studio) dan, kalau ketemu, set
 * SUMMARY_PROVIDER=openai + OPENAI_BASE_URL (+ OPENAI_MODEL) di .env.
 *
 * Dipakai oleh dua tempat:
 * - postinstall (npm install): `force=false`, jadi TIDAK menimpa kalau user sudah pernah
 *   pilih provider secara manual - aman dijalankan berulang (mis. tiap `meetresult update`).
 * - command `meetresult setup-ai`: default juga `force=false`, tapi user bisa pakai --force
 *   untuk deteksi ulang & timpa konfigurasi lama.
 */
async function autoConfigureLocalAi({ force = false } = {}) {
  if (!fs.existsSync(ENV_EXAMPLE_PATH)) {
    return { status: "no-env-example" };
  }
  if (!fs.existsSync(ENV_PATH)) {
    fs.copyFileSync(ENV_EXAMPLE_PATH, ENV_PATH);
  }

  let envContent = fs.readFileSync(ENV_PATH, "utf-8");
  const currentProvider = readEnvValue(envContent, "SUMMARY_PROVIDER");
  const currentBaseUrl = readEnvValue(envContent, "OPENAI_BASE_URL");

  if (!force && (currentProvider || currentBaseUrl)) {
    return { status: "skipped-existing-config" };
  }

  const found = await detectLocalAiServer();
  if (!found) {
    return { status: "not-found" };
  }

  envContent = setEnvValue(envContent, "SUMMARY_PROVIDER", "openai");
  envContent = setEnvValue(envContent, "OPENAI_BASE_URL", found.baseURL);
  if (found.apiKey) {
    envContent = setEnvValue(envContent, "OPENAI_API_KEY", found.apiKey);
  }
  if (found.model) {
    envContent = setEnvValue(envContent, "OPENAI_MODEL", found.model);
  }
  fs.writeFileSync(ENV_PATH, envContent, "utf-8");

  return { status: "configured", ...found };
}

module.exports = { autoConfigureLocalAi };
