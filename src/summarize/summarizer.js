const axios = require("axios");
const fs = require("fs");
const path = require("path");
const config = require("../config/config");
const logger = require("../utils/logger");
const { saveMomDocx } = require("./docxGenerator");
const { renderFromTemplate } = require("./docxTemplateRenderer");
const { buildUniqueFileName, monthSubdir } = require("../utils/filename");
const { askClaudeCli } = require("./claudeCliClient");
const { askOpenAi } = require("./openaiClient");
const { askAgyCli } = require("./agyCliClient");
const { askOpencodeCli } = require("./opencodeCliClient");

const structuredSchema = require("./schemas/structuredSchema");
const meetingMinutesSchema = require("./schemas/meetingMinutesSchema");

const CLAUDE_API_URL = "https://api.anthropic.com/v1/messages";

const SCHEMAS = {
  structured: structuredSchema,
  meeting_minutes: meetingMinutesSchema,
};

function getSchema() {
  return SCHEMAS[config.mom.templateType] || SCHEMAS.structured;
}

function extractJson(text) {
  // Buang code fence markdown jika Claude tetap membungkusnya
  const cleaned = text
    .trim()
    .replace(/^```(json)?/i, "")
    .replace(/```$/, "")
    .trim();

  try {
    return JSON.parse(cleaned);
  } catch (e) {
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (match) {
      return JSON.parse(match[0]);
    }
    throw new Error(`Gagal parse JSON hasil Claude: ${e.message}`);
  }
}

function formatIndonesianDateLabel(dateInput) {
  const d = dateInput ? new Date(dateInput) : new Date();
  return d.toLocaleDateString("id-ID", {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  });
}

async function callClaudeApi(systemPrompt, userPrompt) {
  if (!config.claude.apiKey) {
    throw new Error(
      "ANTHROPIC_API_KEY belum diisi di .env (CLAUDE_MODE=api). Dapatkan di https://console.anthropic.com/settings/keys"
    );
  }

  const { data } = await axios.post(
    CLAUDE_API_URL,
    {
      model: config.claude.model,
      max_tokens: 4096,
      system: systemPrompt,
      messages: [{ role: "user", content: userPrompt }],
    },
    {
      headers: {
        "x-api-key": config.claude.apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
    }
  );

  return data.content?.map((c) => c.text).join("\n") || "";
}

async function callClaudeCli(systemPrompt, userPrompt) {
  // Gabungkan system + user prompt jadi satu teks untuk dikirim via stdin ke `claude -p`
  const fullPrompt = `${systemPrompt}\n\n${userPrompt}`;
  return askClaudeCli(fullPrompt);
}

/**
 * Kirim prompt ke SATU provider AI tertentu (bukan cuma yang lagi aktif di config) - dipisah
 * dari askAI() supaya bisa dipakai ulang untuk provider fallback (lihat askAI() di bawah).
 */
async function callProvider(providerName, systemPrompt, userPrompt) {
  if (providerName === "openai") {
    return askOpenAi(systemPrompt, userPrompt);
  }
  if (providerName === "agy") {
    return askAgyCli(`${systemPrompt}\n\n${userPrompt}`);
  }
  if (providerName === "opencode") {
    return askOpencodeCli(`${systemPrompt}\n\n${userPrompt}`);
  }
  // "claude" (default)
  if (config.claude.mode === "api") {
    return callClaudeApi(systemPrompt, userPrompt);
  }
  return callClaudeCli(systemPrompt, userPrompt);
}

/**
 * Kirim prompt ke provider AI yang aktif (Claude CLI/API, OpenAI-compatible, atau Antigravity
 * CLI) dan kembalikan teks respons mentah. Dipakai baik oleh requestMomFromAI() (ekstraksi
 * awal) maupun polishMomLanguage() (penghalusan bahasa, lihat di bawah).
 *
 * Kalau provider utama gagal (error teknis, kuota habis, dll) DAN SUMMARY_FALLBACK_PROVIDER
 * diisi, otomatis dicoba ulang lewat provider fallback tersebut sebelum benar-benar gagal -
 * supaya notulen tetap bisa dibuat walau 1 provider sedang bermasalah.
 */
async function askAI(systemPrompt, userPrompt) {
  const primary = config.ai.provider;
  try {
    return await callProvider(primary, systemPrompt, userPrompt);
  } catch (err) {
    const fallback = config.ai.fallbackProvider;
    if (!fallback || fallback === primary) throw err;

    logger.warn(`Provider AI notulen '${primary}' gagal (${err.message}) - mencoba fallback '${fallback}'...`);
    try {
      return await callProvider(fallback, systemPrompt, userPrompt);
    } catch (fallbackErr) {
      throw new Error(
        `Provider notulen utama ('${primary}': ${err.message}) DAN fallback ('${fallback}': ${fallbackErr.message}) sama-sama gagal.`
      );
    }
  }
}

async function requestMomFromAI(transcriptText, meetingMeta = {}) {
  const schema = getSchema();
  const provider = config.ai.provider;
  const providerDetail = provider === "claude" ? `claude/${config.claude.mode}` : provider;

  logger.info(
    `Mengirim transkrip ke AI (provider: ${providerDetail}, skema: ${config.mom.templateType}) untuk dibuatkan notulen...`
  );

  const userPrompt = schema.buildUserPrompt(transcriptText, meetingMeta);
  const text = await askAI(schema.SYSTEM_PROMPT, userPrompt);
  return extractJson(text);
}

const POLISH_SYSTEM_PROMPT = `Kamu adalah editor bahasa profesional untuk notulen rapat korporat berbahasa Indonesia.

Tugasmu: terima draft notulen dalam format JSON, lalu perbaiki HANYA kualitas bahasanya -
buat lebih profesional, padat, jelas, dan mengalir seperti notulen korporat resmi.

ATURAN KETAT:
- JANGAN mengubah struktur/nama key JSON sama sekali.
- JUMLAH ITEM di setiap array (mis. discussion, actionItems, resume, attendees) HARUS
  SAMA PERSIS dengan draft asli - jangan menggabungkan, memecah, menambah, atau menghapus
  item apapun. Hanya perbaiki kalimat DI DALAM tiap item.
- JANGAN menghilangkan informasi penting: angka, tanggal, nama orang/perusahaan/sistem,
  keputusan, dan action item WAJIB tetap ada apa adanya (boleh dirapikan kalimatnya, tidak
  boleh hilang esensinya).
- JANGAN menambahkan informasi baru yang tidak ada di draft asli.
- Hilangkan kata pengisi/pengulangan akibat transkripsi lisan (mis. "kan", "gitu", "ya",
  kalimat yang berulang-ulang) dan buat lebih ringkas TANPA mengurangi esensi - kalimat
  hasil perbaikan sebaiknya tidak lebih panjang dari aslinya.
- Field kosong atau "Tidak disebutkan dalam transkrip" biarkan apa adanya, jangan dikarang.
- Field angka/nomor urut JANGAN diubah.

Keluarkan HANYA objek JSON hasil perbaikan, tanpa markdown/code fence/penjelasan tambahan.`;

function buildPolishUserPrompt(momJson) {
  return `Draft notulen (JSON):\n\n${JSON.stringify(momJson, null, 2)}\n\nPerbaiki bahasanya sesuai instruksi, keluarkan JSON hasil perbaikan dengan struktur persis sama.`;
}

/**
 * Validasi bahwa hasil penghalusan bahasa TIDAK mengubah struktur/jumlah item - hanya
 * kalimat di dalamnya yang boleh berubah. Kalau gagal validasi, hasil dianggap tidak aman
 * dipakai (kemungkinan AI menggabungkan/menghapus item) dan draft asli dipertahankan.
 */
function polishedStructureIsValid(original, polished) {
  if (typeof polished !== "object" || polished === null || Array.isArray(polished)) return false;

  const originalKeys = Object.keys(original).sort().join(",");
  const polishedKeys = Object.keys(polished).sort().join(",");
  if (originalKeys !== polishedKeys) return false;

  for (const key of Object.keys(original)) {
    if (Array.isArray(original[key])) {
      if (!Array.isArray(polished[key]) || polished[key].length !== original[key].length) {
        return false;
      }
    }
  }
  return true;
}

/**
 * Tahap kedua (opsional, default aktif - lihat MOM_POLISH_LANGUAGE): kirim ulang JSON MoM
 * hasil ekstraksi ke AI khusus untuk memperbaiki kualitas bahasanya - lebih profesional,
 * padat, dan rapi - TANPA mengubah struktur atau menghilangkan informasi. Gagal dengan aman:
 * kalau hasilnya tidak valid/error, draft asli tetap dipakai (tidak pernah gagal total
 * gara-gara langkah ini).
 */
async function polishMomLanguage(momJson) {
  if (!config.mom.polishLanguage) return momJson;

  try {
    logger.info("Menghaluskan bahasa notulen...");
    const text = await askAI(POLISH_SYSTEM_PROMPT, buildPolishUserPrompt(momJson));
    const polished = extractJson(text);

    if (!polishedStructureIsValid(momJson, polished)) {
      logger.warn(
        "Hasil penghalusan bahasa mengubah struktur/jumlah item - draft asli dipertahankan."
      );
      return momJson;
    }

    return polished;
  } catch (err) {
    logger.warn(`Gagal menghaluskan bahasa notulen (${err.message}) - draft asli dipertahankan.`);
    return momJson;
  }
}

/**
 * Pipeline: transkrip -> Claude (JSON MoM sesuai skema aktif) -> dokumen .docx
 * Nama file: "{JudulMeeting}_{YYYYMMDD}.docx" (otomatis unik)
 */
async function summarizeFile(transcriptFilePath, meetingMeta = {}) {
  const schema = getSchema();
  const transcriptText = fs.readFileSync(transcriptFilePath, "utf-8");
  let momJson = await requestMomFromAI(transcriptText, meetingMeta);
  momJson = await polishMomLanguage(momJson);

  const media = meetingMeta.media || "Online Meeting - Microsoft Teams";
  const templateData = schema.mapToTemplateData(
    momJson,
    meetingMeta,
    formatIndonesianDateLabel,
    config.mom.preparedBy,
    media
  );

  const subject =
    templateData.subject || templateData.meetingTitle || meetingMeta.subject || "Meeting";
  const meetingDate = meetingMeta.start || new Date();

  // Kelompokkan notulen per bulan berdasarkan tanggal meeting - supaya data/summaries/
  // tidak menumpuk jadi 1 folder besar seiring waktu.
  const outDir = monthSubdir(config.SUMMARIES_DIR, meetingDate);
  const fileName = buildUniqueFileName(outDir, subject, meetingDate, ".docx");
  const outputPath = path.join(outDir, fileName);

  if (config.mom.templatePath && fs.existsSync(config.mom.templatePath)) {
    logger.info(`Menggunakan template: ${config.mom.templatePath}`);
    renderFromTemplate(config.mom.templatePath, templateData, outputPath);
  } else if (config.mom.templateType === "structured") {
    logger.warn(
      "Template .docx tidak ditemukan, memakai layout bawaan (hardcoded)."
    );
    await saveMomDocx(templateData, outputPath);
  } else {
    throw new Error(
      `Template tidak ditemukan: ${config.mom.templatePath}. Untuk skema "${config.mom.templateType}" wajib ada file template.`
    );
  }

  // Simpan juga data JSON mentah (untuk keperluan `meetresult show` di terminal)
  const jsonPath = outputPath.replace(/\.docx$/, ".json");
  fs.writeFileSync(
    jsonPath,
    JSON.stringify({ templateType: config.mom.templateType, ...templateData }, null, 2),
    "utf-8"
  );

  logger.success(`Notulen tersimpan: ${outputPath}`);
  return outputPath;
}

module.exports = { summarizeFile, requestMomFromAI, polishMomLanguage };
