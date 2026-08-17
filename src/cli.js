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

program
  .name("meetresult")
  .description(
    "MeetResult - Rekam, transkrip, dan buat notulen rapat Teams secara otomatis (mirip Krisp.ai), Bahasa Indonesia."
  )
  .version("1.0.0");

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
    fs.writeFileSync(pidFile, String(process.pid), "utf-8");

    const cleanupPid = () => {
      try {
        if (fs.existsSync(pidFile)) fs.unlinkSync(pidFile);
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
  .action(async (fileTranskrip, opts) => {
    try {
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
  .action(async (fileAudio, opts) => {
    try {
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
  };
  return map[status] || status;
}

program.parse(process.argv);

if (!process.argv.slice(2).length) {
  program.outputHelp();
}
