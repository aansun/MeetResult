#!/usr/bin/env node
const { Command } = require("commander");
const chalk = require("chalk");
const path = require("path");
const fs = require("fs");

const logger = require("./utils/logger");
const db = require("./storage/db");
const outlookAuth = require("./auth/outlookAuth");
const { getUpcomingTeamsMeetings } = require("./calendar");
const recorder = require("./recorder/recorder");
const { transcribeAudio } = require("./transcribe/transcriber");
const { summarizeFile } = require("./summarize/summarizer");
const { runPipelineForMeeting, retryPipelineForMeeting } = require("./pipeline");
const { startWatcher, finishAndProcess } = require("./scheduler/watcher");
const { cleanupOldRecordings } = require("./utils/retention");
const { summaryJsonPathFor } = require("./utils/filename");
const { recordAlert } = require("./utils/alerts");
const config = require("./config/config");

const program = new Command();

/**
 * Override model AI untuk SEKALI proses ini saja (tidak mengubah .env) - dipakai oleh
 * flag `--model` di command `summarize`/`process`. Aman dilakukan di sini karena tiap
 * invocation CLI adalah proses Node terpisah yang berumur pendek.
 */
function applyModelOverride(model) {
  if (!model) return;
  if (config.ai.provider === "openai") {
    config.openai.model = model;
  } else if (config.ai.provider === "agy") {
    config.agy.model = model;
  } else if (config.ai.provider === "opencode") {
    config.opencode.model = model;
  } else if (config.ai.provider === "ninerouter") {
    config.ninerouter.model = model;
  } else if (config.claude.mode === "api") {
    config.claude.model = model;
  } else {
    config.claude.cliModel = model;
  }
}

function applyTranscribeModelOverride(model) {
  if (!model) return;
  if (config.transcribe.provider === "openai") {
    config.openai.transcribeModel = model;
  } else if (config.transcribe.provider === "openai-compatible") {
    config.openaiCompatibleTranscribe.model = model;
  } else if (config.transcribe.provider === "ninerouter") {
    config.ninerouterTranscribe.model = model;
  } else if (config.transcribe.provider === "gemini") {
    config.gemini.model = model;
  } else {
    config.whisper.model = model;
  }
}

/**
 * Ambil & tampilkan daftar model dari endpoint OpenAI-compatible mana pun via GET
 * <baseURL><modelsPath> - dipakai bareng oleh command `models` untuk scope "summary" (provider
 * notulen openai/ninerouter, modelsPath default "/models") dan "transcribe" (provider
 * openai/openai-compatible/ninerouter - ninerouter pakai modelsPath "/models/stt" karena
 * 9Router punya daftar model TERPISAH khusus speech-to-text), supaya logika fetch+format-nya
 * tidak triplikat berkali-kali.
 */
async function printModelList(baseURL, apiKey, activeModel, modelsPath = "/models") {
  const axios = require("axios");
  const base = (baseURL || "").replace(/\/+$/, "");
  const headers = {};
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  try {
    const { data } = await axios.get(`${base}${modelsPath}`, { headers });
    const ids = (data.data || []).map((m) => m.id).sort();
    if (ids.length === 0) {
      logger.info("Tidak ada model terdaftar di endpoint ini.");
    } else {
      ids.forEach((id) =>
        console.log(`  ${id === activeModel ? chalk.green("● " + id + "  (aktif)") : "  " + id}`)
      );
    }
    logger.info(`Endpoint: ${base}${modelsPath}`);
  } catch (err) {
    logger.error(`Gagal ambil daftar model dari ${base}${modelsPath}: ${err.message}`);
  }
}

program
  .name("meetresult")
  .description(
    "MeetResult - Rekam, transkrip, dan buat notulen rapat Teams secara otomatis, Bahasa Indonesia."
  )
  .version("1.10.9");

program
  .command("login")
  .description("Login ke akun Microsoft Outlook (untuk baca kalender)")
  .action(async () => {
    try {
      await outlookAuth.login();
    } catch (err) {
      logger.error(err.message);
      process.exit(1);
    }
  });

program
  .command("logout")
  .description("Logout dari akun Microsoft Outlook")
  .action(() => outlookAuth.logout());

program
  .command("agenda")
  .description("Tampilkan meeting Teams mendatang dari kalender Outlook")
  .option("-m, --minutes <menit>", "Rentang waktu ke depan (menit)", "1440")
  .action(async (opts) => {
    try {
      const meetings = await getUpcomingTeamsMeetings({
        minutesAhead: Number(opts.minutes),
      });
      if (meetings.length === 0) {
        logger.info("Tidak ada meeting Teams yang terjadwal.");
        return;
      }
      logger.title("AGENDA MEETING TEAMS");
      meetings.forEach((m, i) => {
        console.log(
          chalk.bold(`${i + 1}. ${m.subject}`) +
            `\n   Waktu: ${m.start} - ${m.end}` +
            `\n   Organizer: ${m.organizer || "-"}` +
            `\n   Link: ${m.joinUrl || "-"}\n`
        );
      });
    } catch (err) {
      logger.error(err.message);
      process.exit(1);
    }
  });

program
  .command("watch")
  .description(
    "Mode otomatis: pantau kalender Outlook & rekam meeting Teams secara otomatis sesuai jadwal"
  )
  .action(() => {
    const { metaFile } = require("./utils/watcherMeta");
    const pidFile = path.join(config.DATA_DIR, "watcher.pid");
    fs.writeFileSync(pidFile, String(process.pid), "utf-8");
    // Dicatat supaya tray bisa deteksi kalau source code (src/**, bin/**) berubah SETELAH
    // proses watcher ini start - Node.js hanya baca file sekali saat start, jadi proses yang
    // sudah lama jalan tidak akan otomatis pakai kode terbaru sampai di-restart manual.
    fs.writeFileSync(
      metaFile,
      JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }, null, 2),
      "utf-8"
    );

    const cleanupPid = () => {
      try {
        if (fs.existsSync(pidFile)) fs.unlinkSync(pidFile);
        if (fs.existsSync(metaFile)) fs.unlinkSync(metaFile);
      } catch (e) {}
    };
    process.on("exit", cleanupPid);
    process.on("SIGINT", () => process.exit(0));
    process.on("SIGTERM", () => process.exit(0));

    // Jaring pengaman TERAKHIR - insiden nyata pernah terjadi: 1 exception yang lolos dari
    // timer setTimeout (scheduleAutoStop/scheduleSilenceCheck di watcher.js, TIDAK ada try/catch
    // di level pemanggil) jadi unhandled rejection yang meng-CRASH TOTAL proses watcher, macet
    // sampai di-restart manual (baru ketahuan berhari-hari kemudian). Sumber aslinya sudah
    // diperbaiki, tapi log & lanjutkan proses di sini juga sebagai jaring pengaman kalau ada
    // celah lain yang belum ketahuan - watcher yang tetap jalan (walau 1 siklus gagal) jauh
    // lebih baik daripada watcher yang diam-diam mati total.
    process.on("unhandledRejection", (err) => {
      logger.error(`Unhandled rejection di watcher (proses TETAP jalan): ${err?.message || err}`);
    });
    process.on("uncaughtException", (err) => {
      logger.error(`Uncaught exception di watcher (proses TETAP jalan): ${err?.message || err}`);
    });

    startWatcher();
  });

program
  .command("record")
  .description("Mulai rekam meeting secara manual (tanpa jadwal kalender)")
  .option("-n, --name <nama>", "Nama/judul meeting", "manual-meeting")
  .action((opts) => {
    try {
      const id = `manual-${Date.now()}`;
      const outputFile = recorder.startRecording(id, opts.name);
      db.addMeeting({
        id,
        subject: opts.name,
        start: new Date().toISOString(),
        end: null,
        status: "recording",
        audioFile: outputFile,
        graphEventId: null,
      });
      logger.success(
        `Perekaman manual dimulai. Jalankan 'meetresult stop' untuk berhenti.`
      );
    } catch (err) {
      logger.error(err.message);
      process.exit(1);
    }
  });

program
  .command("stop")
  .description("Hentikan perekaman yang sedang berjalan lalu proses transkrip & notulen")
  .action(async () => {
    const state = recorder.stopRecording();
    if (!state) return;
    const meetingId = state.meetingId;
    db.updateMeeting(meetingId, {
      status: "processing",
      recordingEndedAt: new Date().toISOString(),
    });
    logger.info("Menunggu ffmpeg selesai menutup file (& menggabungkan mic+system jika mode dual)...");
    const finalAudioFile = await recorder.finalizeRecording(state);
    if (finalAudioFile) {
      db.updateMeeting(meetingId, { audioFile: finalAudioFile });
    }
    await finishAndProcess(meetingId);
  });

program
  .command("setup-ai")
  .description(
    "Deteksi ulang server AI lokal (oMLX/Ollama/LM Studio) & set provider notulen otomatis ke .env"
  )
  .option("-f, --force", "Timpa SUMMARY_PROVIDER/OPENAI_BASE_URL walau sudah pernah di-set manual")
  .action(async (opts) => {
    const { autoConfigureLocalAi } = require("./utils/aiProviderSetup");
    logger.info("Mengecek server AI lokal aktif (oMLX / Ollama :11434 / LM Studio :1234)...");
    const result = await autoConfigureLocalAi({ force: opts.force });
    if (result.status === "configured") {
      logger.success(
        `Terdeteksi ${result.name} di ${result.baseURL}. .env di-update: SUMMARY_PROVIDER=openai, OPENAI_BASE_URL=${result.baseURL}` +
          (result.model ? `, OPENAI_MODEL=${result.model}` : "") +
          "."
      );
    } else if (result.status === "not-found") {
      logger.warn(
        "Tidak ada server AI lokal terdeteksi di port default. Konfigurasi di .env tidak diubah."
      );
    } else if (result.status === "skipped-existing-config") {
      logger.info(
        "SUMMARY_PROVIDER/OPENAI_BASE_URL sudah pernah di-set manual di .env - tidak ditimpa. Pakai --force untuk timpa."
      );
    } else {
      logger.warn("File .env.example tidak ditemukan, lewati.");
    }
  });

program
  .command("models")
  .description("Tampilkan daftar model untuk provider notulen atau transkripsi yang aktif")
  .option("--scope <scope>", "Scope model: summary atau transcribe", "summary")
  .action(async (opts) => {
    if (opts.scope === "transcribe") {
      logger.title(`MODEL TRANSKRIPSI (provider: ${config.transcribe.provider})`);
      if (config.transcribe.provider === "openai") {
        await printModelList(config.openai.transcribeBaseURL, config.openai.transcribeApiKey, config.openai.transcribeModel);
      } else if (config.transcribe.provider === "openai-compatible") {
        if (!config.openaiCompatibleTranscribe.baseURL) {
          logger.error("OPENAI_COMPATIBLE_TRANSCRIBE_BASE_URL belum diisi di .env.");
          process.exitCode = 1;
          return;
        }
        await printModelList(
          config.openaiCompatibleTranscribe.baseURL,
          config.openaiCompatibleTranscribe.apiKey,
          config.openaiCompatibleTranscribe.model
        );
      } else if (config.transcribe.provider === "ninerouter") {
        if (!config.ninerouterTranscribe.url) {
          logger.error("NINEROUTER_TRANSCRIBE_URL belum diisi di .env.");
          process.exitCode = 1;
          return;
        }
        // 9Router punya daftar model TERPISAH khusus speech-to-text (/v1/models/stt) - BUKAN
        // daftar model chat biasa (/v1/models).
        await printModelList(
          `${config.ninerouterTranscribe.url}/v1`,
          config.ninerouterTranscribe.apiKey,
          config.ninerouterTranscribe.model,
          "/models/stt"
        );
      } else {
        logger.info("Daftar model endpoint hanya tersedia untuk provider transkripsi openai / openai-compatible / ninerouter.");
      }
      return;
    }
    if (opts.scope !== "summary") {
      logger.error("Scope tidak valid. Gunakan 'summary' atau 'transcribe'.");
      process.exitCode = 1;
      return;
    }

    logger.title(`MODEL TERSEDIA (provider: ${config.ai.provider})`);

    if (config.ai.provider === "openai") {
      await printModelList(config.openai.baseURL, config.openai.apiKey, config.openai.model);
      return;
    }

    if (config.ai.provider === "ninerouter") {
      if (!config.ninerouter.url) {
        logger.error("NINEROUTER_URL belum diisi di .env.");
        process.exitCode = 1;
        return;
      }
      await printModelList(`${config.ninerouter.url}/v1`, config.ninerouter.apiKey, config.ninerouter.model);
      return;
    }

    if (config.ai.provider === "agy") {
      const { execFileSync } = require("child_process");
      try {
        const output = execFileSync(config.agy.cliBin, ["models"], { encoding: "utf-8" });
        output
          .split("\n")
          .map((line) => line.trim())
          .filter(Boolean)
          .filter((line) => !/^fetching/i.test(line))
          .forEach((line) => {
            const [id] = line.split("\t");
            const active = config.agy.model ? id === config.agy.model : false;
            console.log(`  ${active ? chalk.green("● " + line + "  (aktif)") : "  " + line}`);
          });
        if (!config.agy.model) {
          logger.info("AGY_MODEL kosong - agy pakai model default sesi yang sedang login.");
        }
      } catch (err) {
        logger.error(`Gagal ambil daftar model dari '${config.agy.cliBin}': ${err.message}`);
      }
      return;
    }

    if (config.ai.provider === "opencode") {
      const { execFileSync } = require("child_process");
      try {
        const output = execFileSync(config.opencode.cliBin, ["models"], { encoding: "utf-8" });
        output
          .split("\n")
          .map((line) => line.trim())
          .filter(Boolean)
          .forEach((id) => {
            const active = config.opencode.model ? id === config.opencode.model : false;
            console.log(`  ${active ? chalk.green("● " + id + "  (aktif)") : "  " + id}`);
          });
        if (!config.opencode.model) {
          logger.info("OPENCODE_MODEL kosong - opencode pakai model default.");
        }
      } catch (err) {
        logger.error(`Gagal ambil daftar model dari '${config.opencode.cliBin}': ${err.message}`);
      }
      return;
    }

    const activeClaude = config.claude.mode === "api" ? config.claude.model : config.claude.cliModel;
    const printClaude = (id) =>
      console.log(`  ${id === activeClaude ? chalk.green("● " + id + "  (aktif)") : "  " + id}`);

    let liveIds = null;
    if (config.claude.apiKey) {
      try {
        const axios = require("axios");
        const { data } = await axios.get("https://api.anthropic.com/v1/models?limit=100", {
          headers: { "x-api-key": config.claude.apiKey, "anthropic-version": "2023-06-01" },
        });
        liveIds = (data.data || []).map((m) => m.id);
        logger.info("Daftar model TERBARU dari API Anthropic (GET /v1/models):");
      } catch (err) {
        logger.warn(`Gagal ambil daftar dari API Anthropic (${err.message}) - pakai daftar bawaan.`);
      }
    }
    if (liveIds) {
      liveIds.forEach(printClaude);
    } else {
      logger.info(
        "Alias Claude Code CLI (selalu menunjuk model TERBARU, cocok untuk CLAUDE_CLI_MODEL) + ID bawaan " +
          "(isi ANTHROPIC_API_KEY untuk daftar ID lengkap terbaru dari Anthropic):"
      );
      ["opus", "sonnet", "haiku", "claude-opus-5", "claude-sonnet-5", "claude-haiku-4-5-20251001"].forEach(printClaude);
    }
    logger.info(
      `Model aktif saat ini: ${
        config.claude.mode === "api"
          ? config.claude.model
          : config.claude.cliModel || "(default Claude Code CLI)"
      }`
    );
    logger.info(
      `Ganti dengan: meetresult summarize <file> --model <id>  (sekali proses), atau lewat Pengaturan/${
        config.claude.mode === "api" ? "ANTHROPIC_MODEL" : "CLAUDE_CLI_MODEL"
      } di .env (permanen)`
    );
  });

program
  .command("whisper-status")
  .description("Cek apakah model Whisper tertentu sudah terunduh di cache lokal (dipakai Pengaturan menu tray)")
  .option("--model <model>", "Nama model (default: WHISPER_MODEL di .env)")
  .action((opts) => {
    const { checkWhisperModelCached } = require("./transcribe/whisperModelTool");
    const model = opts.model || config.whisper.model;
    const result = checkWhisperModelCached(model);
    console.log(JSON.stringify({ model, ...result }));
  });

program
  .command("whisper-download")
  .description("Unduh model Whisper ke cache lokal (dipakai Pengaturan menu tray)")
  .option("--model <model>", "Nama model (default: WHISPER_MODEL di .env)")
  .action(async (opts) => {
    const { downloadWhisperModel } = require("./transcribe/whisperModelTool");
    const model = opts.model || config.whisper.model;
    logger.info(`Mengunduh model Whisper '${model}'...`);
    try {
      await downloadWhisperModel(model, (chunk) => process.stdout.write(chunk));
      logger.success(`Model '${model}' berhasil diunduh.`);
    } catch (err) {
      logger.error(`Gagal mengunduh model: ${err.message}`);
      process.exit(1);
    }
  });

program
  .command("test-ai")
  .description(
    "Tes semua provider/model yang dikonfigurasi: notulen (utama & fallback) dan transkripsi (utama & fallback) - tiap provider diuji SENDIRI-SENDIRI (tanpa diselamatkan fallback), tanpa bikin file/rekaman"
  )
  .option("--json", "Output hasil sebagai JSON satu baris (dipakai tray Pengaturan), tanpa log berwarna")
  .action(async (opts) => {
    const os = require("os");
    const { spawnSync } = require("child_process");
    const { requestMomFromAI } = require("./summarize/summarizer");
    const { testTranscribeProvider } = require("./transcribe/transcriber");
    const { inspectClaudeInstallations } = require("./utils/claudeBin");
    const { isAuthProviderError, authHint } = require("./utils/providerErrors");
    const jsonMode = !!opts.json;

    // Tes harus jujur: tanpa retry bertele-tele (kalau gagal, langsung kelihatan gagalnya).
    config.ai.transientRetries = 0;
    config.gemini.maxRetries = 1;

    // Timer WAJIB dibatalkan begitu selesai - kalau tidak, timer 90-240 detik yang menggantung
    // menahan proses Node tetap hidup lama setelah semua hasil tercetak (tombol Test di tray
    // menunggu proses ini keluar).
    const withTimeout = (promise, ms, label) => {
      let timer;
      const timeout = new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`Timeout setelah ${Math.round(ms / 1000)} detik - ${label} terlalu lambat merespons`)),
          ms
        );
      });
      return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
    };

    const summaryLabel = (name) =>
      name === "openai"
        ? `openai (${config.openai.baseURL || "https://api.openai.com/v1"}, model: ${config.openai.model || "-"})`
        : name === "agy"
        ? `agy (model: ${config.agy.model || "default"})`
        : name === "opencode"
        ? `opencode (model: ${config.opencode.model || "default"})`
        : name === "ninerouter"
        ? `ninerouter (model: ${config.ninerouter.model || "-"})`
        : `claude/${config.claude.mode} (model: ${
            config.claude.mode === "api" ? config.claude.model : config.claude.cliModel || "default"
          })`;

    const transcribeLabel = (name, role) =>
      name === "gemini"
        ? `gemini (model: ${config.gemini.model || "-"})`
        : name === "openai"
        ? `openai (model: ${config.openai.transcribeModel})`
        : name === "openai-compatible"
        ? `openai-compatible (${config.openaiCompatibleTranscribe.baseURL || "-"}, model: ${config.openaiCompatibleTranscribe.model || "-"})`
        : name === "ninerouter"
        ? `ninerouter (model: ${config.ninerouterTranscribe.model || "-"})`
        : `whisper (model: ${role === "fallback" ? config.whisper.fallbackModel || config.whisper.model : config.whisper.model})`;

    const say = (fn) => {
      if (!jsonMode) fn();
    };
    say(() => logger.title("TES SEMUA PROVIDER/MODEL"));

    const results = [];
    const record = (r) => {
      results.push(r);
      say(() => {
        const head = `[${r.role}] ${r.label}`;
        if (r.ok) logger.success(`${head} - OK (${r.elapsedSeconds} dtk)${r.note ? " - " + r.note : ""}`);
        else logger.error(`${head} - GAGAL: ${r.error}${r.hint ? "\n    -> " + r.hint : ""}`);
      });
    };

    // ---------- Notulen ----------
    const testTranscript =
      "Rapat verifikasi sistem MeetResult. Dian menyampaikan bahwa proses pengujian koneksi AI " +
      "berjalan lancar. Disepakati bahwa Fajar akan mengecek ulang hasil notulen paling lambat " +
      "hari Jumat. Tidak ada kendala lain yang dilaporkan.";
    const markers = ["dian", "fajar", "jumat"];

    const summaryRoles = [{ role: "Notulen - utama", name: config.ai.provider }];
    if (config.ai.fallbackProvider && config.ai.fallbackProvider !== config.ai.provider) {
      summaryRoles.push({ role: "Notulen - fallback", name: config.ai.fallbackProvider });
    }

    for (const { role, name } of summaryRoles) {
      const label = summaryLabel(name);
      const start = Date.now();
      try {
        const result = await withTimeout(
          requestMomFromAI(testTranscript, { subject: "Tes Koneksi AI" }, { providerOnly: name }),
          90000,
          "provider notulen"
        );
        const elapsedSeconds = Math.round(((Date.now() - start) / 1000) * 10) / 10;
        const raw = JSON.stringify(result).toLowerCase();
        if (raw.includes("judul singkat rapat") || raw.includes("nama peserta")) {
          record({
            role, label, ok: false, elapsedSeconds,
            error: "Model mengembalikan teks placeholder mentah dari instruksi, bukan hasil ekstraksi transkrip - model kurang mampu mengikuti instruksi JSON terstruktur.",
          });
          continue;
        }
        const found = markers.filter((m) => raw.includes(m));
        record({
          role, label, ok: true, elapsedSeconds,
          note: found.length === 0
            ? "PERINGATAN: respons valid tapi tidak menyebut detail transkrip tes (model mungkin mengarang)"
            : `konten terverifikasi (${found.join(", ")})`,
          warn: found.length === 0,
        });
      } catch (err) {
        record({
          role, label, ok: false,
          elapsedSeconds: Math.round(((Date.now() - start) / 1000) * 10) / 10,
          error: err.message.replace(/\s+/g, " ").slice(0, 400),
          // Petunjuk login sudah ditempel ke pesan error oleh callProviderChecked() - cukup
          // tambahkan di sini kalau belum ada, supaya tidak tampil dobel.
          hint:
            isAuthProviderError(err.message) && !err.message.includes(" -> ")
              ? authHint(name, name === "claude" ? require("./utils/claudeBin").resolveClaudeBinary() : null)
              : undefined,
        });
      }
    }

    // Peringatan instalasi claude ganda (relevan kalau claude CLI dipakai di peran manapun)
    let claudeWarning = null;
    if (config.claude.mode === "cli" && summaryRoles.some((r) => r.name === "claude")) {
      const info = inspectClaudeInstallations();
      if (info.duplicate) claudeWarning = info.warning;
    }

    // ---------- Transkripsi ----------
    const transcribeRoles = [{ role: "Transkripsi - utama", name: config.transcribe.provider, kind: "primary" }];
    if (config.transcribe.fallbackProvider && config.transcribe.fallbackProvider !== config.transcribe.provider) {
      transcribeRoles.push({ role: "Transkripsi - fallback", name: config.transcribe.fallbackProvider, kind: "fallback" });
    }

    // Audio uji = ucapan sungguhan (macOS `say`, suara Indonesia) berisi nama-nama penanda,
    // supaya yang diuji benar-benar kemampuan mengenali suara, bukan sekadar koneksi.
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "meetresult-testaudio-"));
    const wav = path.join(tmpDir, "tes.wav");
    let audioReady = false;
    let audioError = "";
    try {
      const aiff = path.join(tmpDir, "tes.aiff");
      const sayRes = spawnSync("say", ["-v", "Damayanti", "-o", aiff, "Dian menyampaikan bahwa Fajar akan mengecek ulang hasil notulen paling lambat hari Jumat."]);
      const ff = sayRes.status === 0
        ? spawnSync("ffmpeg", ["-y", "-i", aiff, "-ar", "16000", "-ac", "1", wav], { stdio: "ignore" })
        : null;
      audioReady = !!ff && ff.status === 0 && fs.existsSync(wav);
      if (!audioReady) audioError = "Gagal membuat audio uji (perintah 'say'/ffmpeg tidak tersedia).";
    } catch (e) {
      audioError = `Gagal membuat audio uji: ${e.message}`;
    }

    const audioMarkers = ["dian", "fajar", "jumat"];
    for (const { role, name, kind } of transcribeRoles) {
      const label = transcribeLabel(name, kind);
      if (!audioReady) {
        record({ role, label, ok: false, error: audioError });
        continue;
      }
      const start = Date.now();
      try {
        const text = await withTimeout(testTranscribeProvider(name, wav, kind), 240000, "provider transkripsi");
        const elapsedSeconds = Math.round(((Date.now() - start) / 1000) * 10) / 10;
        const low = text.toLowerCase();
        const found = audioMarkers.filter((m) => low.includes(m));
        if (!text.trim()) {
          record({ role, label, ok: false, elapsedSeconds, error: "Provider mengembalikan transkrip kosong." });
        } else {
          record({
            role, label, ok: true, elapsedSeconds,
            note: found.length >= 2
              ? `transkrip terverifikasi (${found.join(", ")})`
              : `PERINGATAN: hanya ${found.length}/3 kata kunci terbaca - "${text.trim().slice(0, 70)}"`,
            warn: found.length < 2,
          });
        }
      } catch (err) {
        record({
          role, label, ok: false,
          elapsedSeconds: Math.round(((Date.now() - start) / 1000) * 10) / 10,
          error: err.message.replace(/\s+/g, " ").slice(0, 400),
        });
      }
    }
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch (e) {}

    const allOk = results.every((r) => r.ok);
    const anyWarn = results.some((r) => r.ok && r.warn);
    if (jsonMode) {
      console.log(JSON.stringify({ ok: allOk, warn: anyWarn, results, claudeWarning }));
    } else {
      if (claudeWarning) logger.warn(claudeWarning);
      logger.info(
        allOk
          ? anyWarn ? "Semua provider merespons, tapi ada peringatan di atas." : "Semua provider/model berjalan normal."
          : `${results.filter((r) => !r.ok).length} dari ${results.length} tes GAGAL - lihat detail di atas.`
      );
    }
    if (!allOk) process.exitCode = 1;
  });

program
  .command("devices")
  .description("Tampilkan daftar perangkat audio yang terdeteksi ffmpeg")
  .action(async () => {
    logger.title("DAFTAR PERANGKAT AUDIO (ffmpeg)");
    const output = await recorder.listDevices();
    console.log(output);
    logger.info(
      "Set index/nama device yang menangkap AUDIO SISTEM (mis. BlackHole) ke FFMPEG_AUDIO_DEVICE_INDEX di .env"
    );
  });

program
  .command("transcribe <fileAudio>")
  .description("Transkrip manual file audio menggunakan provider transkripsi aktif")
  .option("--model <model>", "Override model transkripsi untuk sekali proses ini saja")
  .action(async (fileAudio, opts) => {
    try {
      applyTranscribeModelOverride(opts.model);
      const filePath = path.resolve(fileAudio);
      const out = await transcribeAudio(filePath);
      logger.success(`Selesai: ${out}`);
    } catch (err) {
      logger.error(err.message);
      process.exit(1);
    }
  });

program
  .command("summarize <fileTranskrip>")
  .description("Buat notulen rapat (.docx) dari file transkrip menggunakan Claude AI")
  .option("-t, --title <judul>", "Judul rapat", "Meeting")
  .option("-d, --date <YYYY-MM-DD>", "Tanggal rapat", "")
  .option("-p, --participants <peserta>", "Daftar peserta (opsional)", "")
  .option("--time <waktu>", "Jam rapat, mis. '09:00 - 10:30 WITA' (untuk skema meeting_minutes)", "")
  .option("--location <lokasi>", "Lokasi rapat (untuk skema meeting_minutes)", "")
  .option("--model <model>", "Override model AI untuk sekali proses ini saja (tidak mengubah .env)")
  .action(async (fileTranskrip, opts) => {
    try {
      applyModelOverride(opts.model);
      const filePath = path.resolve(fileTranskrip);
      const out = await summarizeFile(filePath, {
        subject: opts.title,
        start: opts.date || new Date(),
        participants: opts.participants || undefined,
        time: opts.time || undefined,
        location: opts.location || undefined,
      });
      logger.success(`Selesai: ${out}`);
    } catch (err) {
      logger.error(err.message);
      process.exit(1);
    }
  });

program
  .command("process <fileAudio>")
  .description("Jalankan pipeline lengkap: audio -> transkrip -> notulen")
  .option("-t, --title <judul>", "Judul rapat", "Meeting")
  .option("--model <model>", "Override model AI untuk sekali proses ini saja (tidak mengubah .env)")
  .option("--transcribe-model <model>", "Override model transkripsi untuk sekali proses ini saja")
  .action(async (fileAudio, opts) => {
    try {
      applyModelOverride(opts.model);
      applyTranscribeModelOverride(opts.transcribeModel);
      const filePath = path.resolve(fileAudio);
      const id = `adhoc-${Date.now()}`;
      const record = db.addMeeting({
        id,
        subject: opts.title,
        start: new Date().toISOString(),
        end: new Date().toISOString(),
        status: "recorded",
        audioFile: filePath,
        graphEventId: null,
      });
      await runPipelineForMeeting(record);
    } catch (err) {
      logger.error(err.message);
      process.exit(1);
    }
  });

program
  .command("retry <meetingId>")
  .description("Ulangi proses meeting yang gagal/macet (transkrip ada -> cuma notulen; kalau belum -> transkrip dari audio)")
  .option("--transcribe", "Paksa transkripsi ulang dari audio walau transkrip lama sudah ada")
  .action(async (meetingId, opts) => {
    const record = db.getMeeting(meetingId);
    if (!record) {
      logger.error(`Meeting "${meetingId}" tidak ditemukan.`);
      process.exit(1);
    }
    db.updateMeeting(meetingId, { status: "processing", error: null });
    logger.info(`Memproses ulang meeting: ${record.subject}`);
    try {
      await retryPipelineForMeeting(db.getMeeting(meetingId), { forceTranscribe: !!opts.transcribe });
    } catch (err) {
      logger.error(`Gagal memproses ulang ${record.subject}: ${err.message}`);
      recordAlert({ level: "error", kind: "proses", meeting: record.subject, message: `Proses ulang gagal: ${err.message}` });
      db.updateMeeting(meetingId, { status: "error", error: err.message });
      process.exit(1);
    }
  });

program
  .command("list")
  .description("Daftar semua meeting yang tercatat beserta statusnya")
  .action(() => {
    const meetings = db.listMeetings();
    if (meetings.length === 0) {
      logger.info("Belum ada data meeting.");
      return;
    }
    logger.title("DAFTAR MEETING");
    meetings
      .slice()
      .reverse()
      .forEach((m) => {
        console.log(
          chalk.bold(m.subject) +
            `  [${statusColor(m.status)}]\n` +
            `   ID: ${m.id}\n` +
            `   Mulai: ${m.start || "-"}\n` +
            (m.skipReason ? `   Alasan dilewati: ${m.skipReason}\n` : "") +
            (m.summaryFile ? `   Notulen: ${m.summaryFile}\n` : "") +
            (m.transcriptFile ? `   Transkrip: ${m.transcriptFile}\n` : "")
        );
      });
  });

program
  .command("show <meetingId>")
  .description("Tampilkan ringkasan notulen suatu meeting di terminal")
  .option("-o, --open", "Buka file .docx dengan aplikasi default (Word)")
  .action(async (meetingId, opts) => {
    const m = db.getMeeting(meetingId);
    if (!m) {
      logger.error("Meeting tidak ditemukan.");
      return;
    }
    if (!m.summaryFile || !fs.existsSync(m.summaryFile)) {
      logger.warn("Notulen belum tersedia untuk meeting ini.");
      return;
    }

    // Fallback ke lokasi lama (co-located dengan .docx) untuk notulen yang dibuat SEBELUM
    // json sidecar dipindah ke subfolder json/ (lihat summaryJsonPathFor()).
    const jsonPath = fs.existsSync(summaryJsonPathFor(m.summaryFile))
      ? summaryJsonPathFor(m.summaryFile)
      : m.summaryFile.replace(/\.docx$/, ".json");
    if (fs.existsSync(jsonPath)) {
      const mom = JSON.parse(fs.readFileSync(jsonPath, "utf-8"));

      if (mom.templateType === "meeting_minutes") {
        console.log(chalk.bold.underline(`\nMEETING MINUTES: ${mom.meetingTitle}`));
        console.log(`Tanggal  : ${mom.meetingDate}`);
        console.log(`Waktu    : ${mom.meetingTime}`);
        console.log(`Lokasi   : ${mom.meetingLocation}\n`);
        console.log(chalk.bold("Resume:"));
        (mom.resume || []).forEach((r) =>
          console.log(`  ${r.no}. ${r.point}${r.subpointsText ? "\n     " + r.subpointsText.replace(/\n/g, "\n     ") : ""}`)
        );
        console.log(chalk.bold("\nAttendances:"));
        (mom.attendees || []).forEach((a) =>
          console.log(`  ${a.no}. ${a.name} - ${a.company} (${a.position})`)
        );
      } else {
        console.log(chalk.bold.underline(`\nMINUTES OF MEETING: ${mom.subject}`));
        console.log(`Hari/Tanggal : ${mom.dateLabel}`);
        console.log(`Media        : ${mom.media}`);
        console.log(`Peserta      : ${mom.participants}`);
        console.log(`Disusun oleh : ${mom.preparedBy}\n`);
        console.log(chalk.bold("A. Pembahasan dan Kesepakatan"));
        (mom.discussion || []).forEach((d) =>
          console.log(`  ${d.no}. ${d.topic}\n     Status: ${d.status}\n     Kesepakatan: ${d.agreement}`)
        );
        console.log(chalk.bold("\nB. Action Items"));
        (mom.actionItems || []).forEach((a) =>
          console.log(`  ${a.no}. ${a.item} (PIC: ${a.pic}, Target: ${a.target})`)
        );
      }
      console.log(chalk.gray(`\nFile lengkap: ${m.summaryFile}`));
    } else {
      logger.info(`File notulen: ${m.summaryFile}`);
    }

    if (opts.open) {
      const open = require("open");
      await open(m.summaryFile);
    }
  });

program
  .command("tray")
  .description("Jalankan indikator menu bar macOS (icon 'MR' + kontrol Start/Stop)")
  .action(() => {
    const os = require("os");
    const trayBinary = path.join(config.ROOT_DIR, "bin", "meetresult-tray");

    if (os.platform() !== "darwin") {
      logger.error("Fitur menu bar hanya tersedia di macOS.");
      process.exit(1);
    }

    if (!fs.existsSync(trayBinary)) {
      logger.info("Binary menu bar belum ada, compiling dari source Swift...");
      const buildScript = path.join(config.ROOT_DIR, "mac", "build.sh");
      const result = require("child_process").spawnSync("bash", [buildScript], {
        stdio: "inherit",
      });
      if (result.status !== 0 || !fs.existsSync(trayBinary)) {
        logger.error(
          "Gagal compile menu bar app. Pastikan Xcode Command Line Tools terinstall (xcode-select --install)."
        );
        process.exit(1);
      }
    }

    // Cegah instance dobel (icon 'MR' duplikat di menu bar)
    try {
      const existingPids = require("child_process")
        .execSync(`pgrep -f "${trayBinary}"`)
        .toString()
        .trim();
      if (existingPids) {
        logger.warn(
          "MeetResultTray sudah berjalan (cek icon 'MR' di menu bar). Tidak membuka instance baru."
        );
        process.exit(0);
      }
    } catch (e) {
      // pgrep exit code 1 = tidak ada proses ditemukan, aman lanjut
    }

    const child = require("child_process").spawn(trayBinary, [config.ROOT_DIR], {
      detached: true,
      stdio: "ignore",
    });
    child.unref();

    logger.success(
      "MeetResultTray berjalan di menu bar (cari icon 'MR' di kanan atas layar)."
    );
    logger.info(
      "Gunakan menu tersebut untuk Start/Stop watcher & buka folder notulen."
    );
  });

program
  .command("cleanup")
  .description(
    `Hapus manual file audio yang sudah lebih tua dari ${config.retention.audioDays} hari (AUDIO_RETENTION_DAYS)`
  )
  .action(() => {
    const { deleted } = cleanupOldRecordings();
    if (deleted.length === 0) {
      logger.info("Tidak ada file audio yang perlu dihapus.");
    } else {
      logger.success(`${deleted.length} file audio dihapus.`);
    }
  });

program
  .command("update")
  .description("Cek (atau terapkan) update versi terbaru MeetResult dari GitHub")
  .option("-a, --apply", "Langsung terapkan update (git pull + npm install)")
  .action(async (opts) => {
    const { checkForUpdates, applyUpdate, getLocalVersion, REPO_URL } = require("./utils/updater");
    try {
      logger.info(`Versi terpasang saat ini: v${getLocalVersion()}`);
      logger.info("Mengecek update dari GitHub...");
      const result = await checkForUpdates();

      if (!result.hasUpdate) {
        logger.success(`Sudah versi terbaru. ${result.detail || ""}`);
        return;
      }

      logger.warn(`Update tersedia! ${result.detail}`);
      logger.info(`Repo: ${REPO_URL}`);

      if (opts.apply) {
        await applyUpdate();
      } else {
        logger.info(
          "Jalankan 'meetresult update --apply' untuk langsung update, atau 'git pull' manual."
        );
      }
    } catch (err) {
      logger.error(err.message);
      process.exit(1);
    }
  });

function statusColor(status) {
  const map = {
    scheduled: chalk.gray("terjadwal"),
    recording: chalk.red("merekam"),
    recorded: chalk.yellow("terekam"),
    processing: chalk.yellow("memproses"),
    transcribed: chalk.blue("ditranskrip"),
    done: chalk.green("selesai"),
    error: chalk.red("error"),
    skipped: chalk.gray("dilewati (bukan meeting aktif)"),
  };
  return map[status] || status;
}

program.parse(process.argv);

if (!process.argv.slice(2).length) {
  program.outputHelp();
}
