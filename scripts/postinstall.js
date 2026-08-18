#!/usr/bin/env node
const { autoConfigureLocalAi } = require("../src/utils/aiProviderSetup");

autoConfigureLocalAi()
  .then((result) => {
    if (result.status === "configured") {
      console.log(
        `[postinstall] Terdeteksi ${result.name} aktif di ${result.baseURL} - SUMMARY_PROVIDER otomatis di-set ke "openai" (lokal, gratis, tanpa API key). Ganti manual di .env kapan saja kalau mau pakai Claude.`
      );
    } else if (result.status === "not-found") {
      console.log(
        '[postinstall] Tidak ada server AI lokal (Ollama/MLX/LM Studio) terdeteksi di port default - SUMMARY_PROVIDER tetap default "claude". Jalankan "meetresult setup-ai" kapan saja untuk cek ulang.'
      );
    }
    // status "skipped-existing-config" / "no-env-example" -> diam, tidak perlu noise
  })
  .catch((err) => {
    console.warn(`[postinstall] Lewati auto-deteksi AI lokal: ${err.message}`);
  });
