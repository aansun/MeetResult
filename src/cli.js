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
const { runPipelineForMeeting } = require("./pipeline");
const { startWatcher, finishAndProcess } = require("./scheduler/watcher");
const { cleanupOldRecordings } = require("./utils/retention");
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
  } else if (config.claude.mode === "api") {
    config.claude.model = model;
  } else {
    config.claude.cliModel = model;
  }
}

program
  .name("meetresult")
  .description(
    "MeetResult - Rekam, transkrip, dan buat notulen rapat Teams secara otomatis, Bahasa Indonesia."
  )
  .version("1.7.0");

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
    const pidFile = path.join(config.DATA_DIR, "watcher.pid");
    const metaFile = path.join(config.DATA_DIR, "watcher-meta.json");
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
  .description("Tampilkan daftar model yang tersedia untuk provider AI notulen yang aktif")
  .action(async () => {
    logger.title(`MODEL TERSEDIA (provider: ${config.ai.provider})`);

    if (config.ai.provider === "openai") {
      const axios = require("axios");
      const baseURL = (config.openai.baseURL || "https://api.openai.com/v1").replace(/\/+$/, "");
      const headers = {};
      if (config.openai.apiKey) headers.Authorization = `Bearer ${config.openai.apiKey}`;

      try {
        const { data } = await axios.get(`${baseURL}/models`, { headers });
        const ids = (data.data || []).map((m) => m.id).sort();
        if (ids.length === 0) {
          logger.info("Tidak ada model terdaftar di endpoint ini.");
        } else {
          ids.forEach((id) =>
            console.log(`  ${id === config.openai.model ? chalk.green("● " + id + "  (aktif)") : "  " + id}`)
          );
        }
        logger.info(`Endpoint: ${baseURL}/models`);
      } catch (err) {
        logger.error(`Gagal ambil daftar model dari ${baseURL}: ${err.message}`);
      }
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

    logger.info("Claude tidak punya endpoint daftar model publik - gunakan salah satu ID berikut:");
    ["claude-opus-5", "claude-sonnet-5", "claude-haiku-4-5-20251001"].forEach((id) => {
      const active =
        config.claude.mode === "api" ? config.claude.model === id : config.claude.cliModel === id;
      console.log(`  ${active ? chalk.green("● " + id + "  (aktif)") : "  " + id}`);
    });
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
    "Tes cepat provider/model AI notulen yang aktif - kirim transkrip kecil, cek responsnya valid & benar-benar mengikuti isi transkrip (tanpa bikin file/rekaman)"
  )
  .option("--json", "Output hasil sebagai JSON satu baris (dipakai tray Pengaturan), tanpa log berwarna")
  .action(async (opts) => {
    const { requestMomFromAI } = require("./summarize/summarizer");
    const jsonMode = !!opts.json;

    const providerLabel =
      config.ai.provider === "openai"
        ? `openai (${config.openai.baseURL || "https://api.openai.com/v1"}, model: ${
            config.openai.model || "-"
          })`
        : config.ai.provider === "agy"
        ? `agy (model: ${config.agy.model || "default"})`
        : `claude/${config.claude.mode} (model: ${
            config.claude.mode === "api" ? config.claude.model : config.claude.cliModel || "default"
          })`;

    if (!jsonMode) {
      logger.title("TES PROVIDER/MODEL AI");
      logger.info(`Provider aktif: ${providerLabel}`);
    }

    // Transkrip kecil dengan detail unik (nama & hari) yang HARUS muncul di hasil kalau
    // model benar-benar membaca & mengekstrak isi transkrip, bukan mengarang/echo placeholder.
    const testTranscript =
      "Rapat verifikasi sistem MeetResult. Dian menyampaikan bahwa proses pengujian koneksi AI " +
      "berjalan lancar. Disepakati bahwa Fajar akan mengecek ulang hasil notulen paling lambat " +
      "hari Jumat. Tidak ada kendala lain yang dilaporkan.";
    const markers = ["dian", "fajar", "jumat"];
    const timeoutMs = 60000;

    if (!jsonMode) {
      logger.info(`Mengirim transkrip tes (timeout ${timeoutMs / 1000} detik)...`);
    }

    const start = Date.now();
    let result;
    try {
      result = await Promise.race([
        requestMomFromAI(testTranscript, { subject: "Tes Koneksi AI" }),
        new Promise((_, reject) =>
          setTimeout(
            () => reject(new Error(`Timeout setelah ${timeoutMs / 1000} detik - provider terlalu lambat merespons`)),
            timeoutMs
          )
        ),
      ]);
    } catch (err) {
      if (jsonMode) {
        console.log(JSON.stringify({ ok: false, stage: "request", error: err.message, providerLabel }));
      } else {
        logger.error(`GAGAL: ${err.message}`);
        logger.info(
          "Kemungkinan penyebab: API key salah/kadaluarsa, endpoint tidak bisa diakses, model ID tidak valid/tidak ada, atau CLI belum login."
        );
      }
      process.exit(1);
    }

    const elapsedSeconds = Math.round(((Date.now() - start) / 1000) * 10) / 10;
    const raw = JSON.stringify(result).toLowerCase();

    // Pola kegagalan nyata yang pernah terjadi: model mengembalikan teks instruksi/placeholder
    // dari system prompt mentah-mentah ("judul singkat rapat", "nama peserta", dst), bukan
    // hasil ekstraksi transkrip - biasanya tanda model terlalu lemah untuk tugas ini.
    const placeholderHit = raw.includes("judul singkat rapat") || raw.includes("nama peserta");
    if (placeholderHit) {
      if (jsonMode) {
        console.log(JSON.stringify({ ok: false, stage: "placeholder", elapsedSeconds, providerLabel }));
      } else {
        logger.error(
          "GAGAL: model mengembalikan teks placeholder mentah dari instruksi, bukan hasil ekstraksi transkrip asli."
        );
        logger.info("Model ini kemungkinan tidak cukup mampu mengikuti instruksi JSON terstruktur - coba model lain.");
      }
      process.exit(1);
    }

    const markersFound = markers.filter((m) => raw.includes(m));

    if (jsonMode) {
      console.log(JSON.stringify({ ok: true, elapsedSeconds, markersFound, providerLabel }));
      return;
    }

    logger.success(`Respons diterima dalam ${elapsedSeconds} detik, format JSON valid.`);
    if (markersFound.length === 0) {
      logger.warn(
        "PERINGATAN: respons valid tapi tidak menyebut satupun detail dari transkrip tes (nama/hari yang disisipkan) - model mungkin mengarang konten, bukan benar-benar membaca transkrip. Waspada saat dipakai untuk meeting asli."
      );
    } else {
      logger.success(`Konten terverifikasi mengikuti isi transkrip tes (ditemukan: ${markersFound.join(", ")}).`);
    }
    logger.success("Provider/model ini siap dipakai untuk notulen.");
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
  .description("Transkrip manual sebuah file audio (Whisper, Bahasa Indonesia)")
  .action(async (fileAudio) => {
    try {
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
  .action(async (fileAudio, opts) => {
    try {
      applyModelOverride(opts.model);
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

    const jsonPath = m.summaryFile.replace(/\.docx$/, ".json");
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
