const axios = require("axios");
const fs = require("fs");
const path = require("path");
const config = require("../config/config");
const logger = require("../utils/logger");
const { saveMomDocx } = require("./docxGenerator");
const { renderFromTemplate } = require("./docxTemplateRenderer");
const { buildUniqueFileName } = require("../utils/filename");
const { askClaudeCli } = require("./claudeCliClient");

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

async function requestMomFromClaude(transcriptText, meetingMeta = {}) {
  const schema = getSchema();

  logger.info(
    `Mengirim transkrip ke Claude (mode: ${config.claude.mode}, skema: ${config.mom.templateType}) untuk dibuatkan notulen...`
  );

  const userPrompt = schema.buildUserPrompt(transcriptText, meetingMeta);

  const text =
    config.claude.mode === "api"
      ? await callClaudeApi(schema.SYSTEM_PROMPT, userPrompt)
      : await callClaudeCli(schema.SYSTEM_PROMPT, userPrompt);

  return extractJson(text);
}

/**
 * Pipeline: transkrip -> Claude (JSON MoM sesuai skema aktif) -> dokumen .docx
 * Nama file: "{JudulMeeting}_{YYYYMMDD}.docx" (otomatis unik)
 */
async function summarizeFile(transcriptFilePath, meetingMeta = {}) {
  const schema = getSchema();
  const transcriptText = fs.readFileSync(transcriptFilePath, "utf-8");
  const momJson = await requestMomFromClaude(transcriptText, meetingMeta);

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

  const fileName = buildUniqueFileName(
    config.SUMMARIES_DIR,
    subject,
    meetingDate,
    ".docx"
  );
  const outputPath = path.join(config.SUMMARIES_DIR, fileName);

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

module.exports = { summarizeFile, requestMomFromClaude };
