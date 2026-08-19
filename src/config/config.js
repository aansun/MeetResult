const path = require("path");
const fs = require("fs");
const dotenv = require("dotenv");

const ROOT_DIR = path.resolve(__dirname, "..", "..");
dotenv.config({ path: path.join(ROOT_DIR, ".env") });

const DATA_DIR = path.join(ROOT_DIR, "data");
const RECORDINGS_DIR = path.join(DATA_DIR, "recordings");
const TRANSCRIPTS_DIR = path.join(DATA_DIR, "transcripts");
const SUMMARIES_DIR = path.join(DATA_DIR, "summaries");
const DB_FILE = path.join(DATA_DIR, "db.json");
const TOKEN_CACHE_FILE = path.join(DATA_DIR, "token-cache.json");

[DATA_DIR, RECORDINGS_DIR, TRANSCRIPTS_DIR, SUMMARIES_DIR].forEach((dir) => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

module.exports = {
  ROOT_DIR,
  DATA_DIR,
  RECORDINGS_DIR,
  TRANSCRIPTS_DIR,
  SUMMARIES_DIR,
  DB_FILE,
  TOKEN_CACHE_FILE,

  calendar: {
    // "graph" (butuh Azure App) atau "ics" (cukup URL publish kalender Outlook)
    mode: process.env.CALENDAR_MODE || "ics",
  },

  azure: {
    clientId: process.env.AZURE_CLIENT_ID || "",
    tenantId: process.env.AZURE_TENANT_ID || "common",
  },

  ics: {
    url: process.env.CALENDAR_ICS_URL || "",
  },

  ai: {
    // Provider yang dipakai untuk membuat notulen (teks transkrip -> JSON MoM):
    // "claude" (default): pakai Claude, lihat konfigurasi `claude.*` di bawah
    // "openai": pakai endpoint Chat Completions OpenAI-compatible, lihat `openai.*` di bawah -
    //   bisa OpenAI cloud ATAU server LOKAL (Ollama/MLX/LM Studio) via OPENAI_BASE_URL
    provider: (process.env.SUMMARY_PROVIDER || "claude").toLowerCase(),
  },

  claude: {
    // "cli" (default): pakai Claude Code CLI yang sudah login (`claude login`), tanpa API key terpisah
    // "api": pakai Anthropic Messages API langsung, butuh ANTHROPIC_API_KEY
    mode: process.env.CLAUDE_MODE || (process.env.ANTHROPIC_API_KEY ? "api" : "cli"),
    apiKey: process.env.ANTHROPIC_API_KEY || "",
    model: process.env.ANTHROPIC_MODEL || "claude-3-5-sonnet-latest",
    cliBin: process.env.CLAUDE_CLI_BIN || "claude",
    cliModel: process.env.CLAUDE_CLI_MODEL || "",
  },

  openai: {
    // Base URL OpenAI-compatible - default ke OpenAI cloud, tapi bisa diarahkan ke server LOKAL
    // yang expose endpoint yang sama, mis. Ollama (http://localhost:11434/v1), MLX/mlx-omni-server
    // (http://localhost:10240/v1), atau LM Studio (http://localhost:1234/v1).
    baseURL: process.env.OPENAI_BASE_URL || "https://api.openai.com/v1",
    // Kosongkan jika server lokal tidak butuh autentikasi (umum untuk Ollama/MLX/LM Studio)
    apiKey: process.env.OPENAI_API_KEY || "",
    model: process.env.OPENAI_MODEL || "gpt-4o-mini",
  },

  whisper: {
    bin: process.env.WHISPER_BIN || "whisper",
    model: process.env.WHISPER_MODEL || "medium",
    language: process.env.WHISPER_LANGUAGE || "id",
    // Batched inference: percepat 2-4x untuk audio panjang (hanya didukung whisper-ctranslate2)
    batched: (process.env.WHISPER_BATCHED || "true") === "true",
    batchSize: Number(process.env.WHISPER_BATCH_SIZE || 8),
    // VAD filter: skip bagian hening/silence -> lebih cepat & kurangi halusinasi teks
    vadFilter: (process.env.WHISPER_VAD_FILTER || "true") === "true",
  },

  ffmpeg: {
    // "dual" (default, direkomendasikan): rekam 2 device terpisah secara paralel lalu digabung -
    //   MIC_DEVICE_INDEX (suara kamu) + SYSTEM_DEVICE_INDEX/BlackHole (suara lawan bicara via Output).
    //   Diperlukan karena banyak aplikasi (mis. Microsoft Teams) TIDAK bisa pakai Aggregate Device
    //   sebagai Microphone jika berisi >1 sumber gabungan - tapi Aggregate/Multi-Output untuk
    //   SPEAKER/Output tetap didukung baik.
    // "single": mode lama, rekam dari 1 device saja (FFMPEG_AUDIO_DEVICE_INDEX).
    mode: process.env.RECORD_MODE || "dual",
    deviceIndex: process.env.FFMPEG_AUDIO_DEVICE_INDEX || ":0", // dipakai jika mode=single
    micDeviceIndex: process.env.FFMPEG_MIC_DEVICE_INDEX || ":0", // mic asli kamu (bukan aggregate)
    systemDeviceIndex: process.env.FFMPEG_SYSTEM_DEVICE_INDEX || ":0", // BlackHole 2ch
    sampleRate: process.env.RECORDING_SAMPLE_RATE || "16000",
  },

  watch: {
    intervalMinutes: Number(process.env.WATCH_INTERVAL_MINUTES || 2),
    leadMinutes: Number(process.env.RECORD_LEAD_MINUTES || 1),
  },

  detection: {
    // Cek apakah Microsoft Teams sedang berjalan SEBELUM mulai auto-record - kalau tidak
    // jalan sama sekali saat jadwal mulai, auto-record DIBATALKAN (kemungkinan meeting
    // di-cancel/reschedule tapi event lama masih ada di kalender). Tidak berlaku untuk
    // rekam manual (`meetresult record`) - itu selalu keputusan eksplisit user.
    requireTeamsRunning: (process.env.REQUIRE_TEAMS_RUNNING || "true") === "true",
    // Berapa menit setelah mulai rekam, cek ULANG apakah channel audio Teams (system/
    // BlackHole) benar-benar ada suara. Kalau di menit itu Teams TIDAK berjalan DAN audio
    // diam total sejak mulai - rekaman dihentikan otomatis & TIDAK diproses (skip
    // transkrip+notulen), mencegah percakapan pribadi di luar meeting ikut terekam &
    // dirangkum AI. Set ke 0 untuk nonaktifkan cek ini.
    silenceCheckAfterMinutes: Number(process.env.SILENCE_CHECK_AFTER_MINUTES || 5),
    // Ambang batas dianggap "diam" dalam dBFS (makin negatif = makin sensitif/gampang
    // dianggap ada suara). Default -50dB cukup aman untuk suara percakapan normal.
    silenceThresholdDb: Number(process.env.SILENCE_THRESHOLD_DB || -50),
  },

  retention: {
    // Berapa hari file audio hasil rekaman disimpan sebelum dihapus otomatis
    audioDays: Number(process.env.AUDIO_RETENTION_DAYS || 3),
  },

  mom: {
    // Nama yang tercantum di kolom "Disusun oleh" pada dokumen MoM
    preparedBy: process.env.MOM_PREPARED_BY || "MeetResult (Auto-generated by AI)",
    // Nama program/organisasi opsional yang tampil sebagai subjudul dokumen
    orgName: process.env.MOM_ORG_NAME || "",
    // Skema/tipe MoM: "structured" (tabel Pembahasan+Action Items) atau
    // "meeting_minutes" (narasi Resume + tabel Attendances, gaya formal/audit)
    templateType: process.env.MOM_TEMPLATE_TYPE || "structured",
    // Path file template .docx (berisi tag). Ganti/tunjuk ke file lain di folder Template/
    // untuk pakai template baru TANPA ubah kode. Jika kosong, default mengikuti templateType.
    templatePath: process.env.MOM_TEMPLATE_PATH
      ? path.resolve(ROOT_DIR, process.env.MOM_TEMPLATE_PATH)
      : path.join(
          ROOT_DIR,
          "Template",
          process.env.MOM_TEMPLATE_TYPE === "meeting_minutes"
            ? "mom_meeting_minutes_template.docx"
            : "mom_template.docx"
        ),
  },
};
