const cron = require("node-cron");
const config = require("../config/config");
const logger = require("../utils/logger");
const db = require("../storage/db");
const recorder = require("../recorder/recorder");
const { getUpcomingTeamsMeetings } = require("../calendar");
const { runPipelineForMeeting } = require("../pipeline");
const { cleanupOldRecordings } = require("../utils/retention");
const { isTeamsRunning } = require("../utils/teamsDetect");
const { hasRecentAudioActivity } = require("../utils/audioActivity");
const { checkAndRepairClaudeCliSymlinks } = require("../utils/claudeCliHealth");
const { updateWatcherMeta, readWatcherMeta } = require("../utils/watcherMeta");
const { recordAlert } = require("../utils/alerts");

let stopTimer = null;

/**
 * Cek & perbaiki otomatis symlink `claude` CLI kalau rusak akibat Claude Desktop auto-update
 * (lihat claudeCliHealth.js) - hanya relevan kalau Claude CLI benar-benar dipakai (mode "cli"
 * untuk notulen, primary ATAU fallback), supaya tidak melakukan cek sia-sia untuk setup yang
 * tidak pakai Claude CLI sama sekali.
 */
function selfHealClaudeCliIfRelevant() {
  const usesClaudeCli =
    config.claude.mode === "cli" &&
    (config.ai.provider === "claude" || config.ai.fallbackProvider === "claude");
  if (!usesClaudeCli) return;
  checkAndRepairClaudeCliSymlinks();
}

/**
 * Hentikan rekaman aktif TANPA lanjut ke transkrip+notulen - dipakai saat mekanisme deteksi
 * (lihat scheduleSilenceCheck()) menyimpulkan ini kemungkinan besar BUKAN meeting aktif,
 * supaya percakapan pribadi/audio di luar meeting tidak ikut ditranskrip & dirangkum AI.
 * File audio & transkrip tetap tersimpan (mengikuti retensi normal) untuk referensi manual.
 */
async function stopAndDiscardRecording(record, reason) {
  logger.warn(`Rekaman "${record.subject}" dihentikan otomatis: ${reason}`);
  try {
    const state = recorder.stopRecording();
    if (state) {
      const finalAudioFile = await recorder.finalizeRecording(state);
      if (finalAudioFile) {
        db.updateMeeting(record.id, { audioFile: finalAudioFile });
      }
    }
    db.updateMeeting(record.id, { status: "skipped", skipReason: reason });
  } catch (err) {
    // finalizeRecording (gabung mic+system via ffmpeg) bisa gagal (mis. file rusak/kepotong
    // paksa) - JANGAN biarkan exception ini lolos ke pemanggil (setTimeout di
    // scheduleSilenceCheck() TIDAK ada try/catch di level itu, jadi promise reject di sini
    // akan CRASH seluruh proses watcher - insiden nyata yang pernah terjadi). Tandai error
    // saja, audio mentah (belum digabung) tetap ada di data/recordings/ untuk pemulihan manual.
    logger.error(`Gagal finalize rekaman "${record.subject}" yang dibuang: ${err.message}`);
    recordAlert({ level: "error", kind: "rekaman", meeting: record.subject, message: `Gagal finalize rekaman: ${err.message}` });
    db.updateMeeting(record.id, { status: "error", error: `Gagal finalize rekaman: ${err.message}` });
  }
}

/**
 * Jadwalkan 1x pengecekan di menit ke-N setelah rekaman mulai (config.detection.
 * silenceCheckAfterMinutes): kalau Microsoft Teams TIDAK berjalan DAN channel audio system
 * (BlackHole, suara Teams) diam total sejak mulai rekam - kemungkinan besar bukan meeting
 * aktif, hentikan & buang (jangan diproses). Kedua sinyal harus SAMA-SAMA menunjukkan "tidak
 * aktif" supaya meeting asli yang cuma hening di awal (nunggu peserta join, dsb) tidak
 * salah dihentikan.
 */
function scheduleSilenceCheck(record, state, stopInMs) {
  const minutes = config.detection.silenceCheckAfterMinutes;
  if (!minutes || minutes <= 0) return;

  const checkInMs = Math.min(minutes * 60 * 1000, Math.max(stopInMs - 30000, 10000));

  setTimeout(async () => {
    // Callback setTimeout TIDAK punya try/catch di level pemanggil manapun (beda dari
    // checkAndAct() yang selalu dibungkus try/catch) - exception yang lolos dari sini jadi
    // unhandled rejection yang CRASH seluruh proses watcher (insiden nyata pernah terjadi
    // lewat jalur serupa di scheduleAutoStop()). Bungkus semuanya supaya bug apapun di sini
    // paling parah cuma gagal 1 siklus, bukan mematikan watcher total.
    try {
      if (recorder.getActiveMeetingId() !== record.id) return; // sudah berhenti lebih dulu

      const teamsRunning = isTeamsRunning();
      const systemFile = state?.tempFiles?.system;
      const activity = systemFile
        ? hasRecentAudioActivity(systemFile, {
            lookbackSeconds: minutes * 60,
            thresholdDb: config.detection.silenceThresholdDb,
          })
        : null;
      // Kalau belum bisa dicek (mode single, atau file belum cukup data), JANGAN anggap diam -
      // lebih aman biarkan rekaman lanjut daripada salah membuang meeting yang asli.
      const audioSilent = activity ? activity.isSilent : false;

      if (!teamsRunning && audioSilent) {
        await stopAndDiscardRecording(
          record,
          `Microsoft Teams tidak berjalan & tidak ada aktivitas audio meeting selama ${minutes} menit pertama - kemungkinan besar bukan meeting aktif.`
        );
      }
    } catch (err) {
      logger.error(`scheduleSilenceCheck gagal untuk "${record.subject}": ${err.message}`);
    }
  }, checkInMs);
}

/**
 * True kalau meeting yang jadwalnya sudah lewat MASIH boleh terus direkam (Teams masih
 * berjalan DAN belum melebihi batas overtime maksimum) - dipakai bareng oleh scheduleAutoStop()
 * (fast path) dan reconcile di checkAndAct() (jaring pengaman) supaya keduanya konsisten,
 * tidak ada jalur yang memotong rekaman padahal jalur lain baru saja memutuskan memperpanjang.
 */
function shouldExtendPastSchedule(endMs) {
  const overtimeMs = Date.now() - endMs;
  if (overtimeMs >= config.watch.maxOvertimeMinutes * 60 * 1000) return false;
  return isTeamsRunning();
}

/**
 * Jadwalkan pengecekan auto-stop untuk 1 meeting - kalau waktunya tiba dan Teams TERNYATA
 * masih berjalan (meeting molor dari jadwal kalender), rekaman TIDAK dipotong, diperpanjang &
 * dicek ulang tiap `overtimeCheckIntervalMinutes` sampai Teams ditutup atau melewati
 * `maxOvertimeMinutes` (lihat shouldExtendPastSchedule()).
 */
function scheduleAutoStop(record, endMs, delayMs) {
  setTimeout(async () => {
    // Sama seperti scheduleSilenceCheck() - callback ini TIDAK dilindungi try/catch pemanggil
    // manapun, jadi exception yang lolos = unhandled rejection = CRASH total proses watcher.
    // Ini JALUR ASLI insiden nyata: finalizeRecording() gagal (ffmpeg SIGKILL sebelum sempat
    // menutup file bersih) tanpa try/catch di sini menyebabkan watcher mati total sejak itu,
    // semua meeting berikutnya tidak ter-rekam sampai di-restart manual.
    try {
      if (recorder.getActiveMeetingId() !== record.id) return; // sudah berhenti lebih dulu

      if (shouldExtendPastSchedule(endMs)) {
        const overtimeMin = Math.round((Date.now() - endMs) / 60000);
        logger.info(
          `Rapat "${record.subject}" sudah lewat jadwal selesai ${overtimeMin} menit tapi Teams masih berjalan - rekaman diperpanjang, dicek ulang ${config.watch.overtimeCheckIntervalMinutes} menit lagi.`
        );
        scheduleAutoStop(record, endMs, config.watch.overtimeCheckIntervalMinutes * 60 * 1000);
        return;
      }

      await stopActiveRecording(record);
    } catch (err) {
      logger.error(`scheduleAutoStop gagal untuk "${record.subject}": ${err.message}`);
    }
  }, delayMs);
}

/**
 * Hentikan rekaman aktif untuk 1 meeting record, gabungkan audio, lalu lanjut ke
 * pipeline transkrip+notulen. Dipakai baik oleh scheduleAutoStop() (fast path)
 * maupun oleh mekanisme reconcile di checkAndAct() (jaring pengaman).
 */
async function finalizeActiveRecording(record) {
  try {
    const state = recorder.stopRecording();
    if (state) {
      const finalAudioFile = await recorder.finalizeRecording(state);
      if (finalAudioFile) {
        db.updateMeeting(record.id, { audioFile: finalAudioFile });
      }
    }
    return true;
  } catch (err) {
    // finalizeRecording (gabung mic+system via ffmpeg) bisa gagal (mis. proses ffmpeg dipaksa
    // SIGKILL sebelum sempat menutup file dengan bersih). Dipanggil dari setTimeout di
    // scheduleAutoStop() yang TIDAK punya try/catch di level pemanggil - kalau exception ini
    // lolos, promise reject-nya CRASH seluruh proses watcher (insiden nyata: watcher mati total
    // sejak itu, semua meeting berikutnya tidak ter-rekam sampai di-restart manual). Tandai
    // meeting error & JANGAN lanjut finishAndProcess (audio final belum berhasil dibuat) -
    // audio mentah (belum digabung) tetap ada di data/recordings/ untuk pemulihan manual.
    logger.error(`Gagal finalize rekaman "${record.subject}": ${err.message}`);
    recordAlert({ level: "error", kind: "rekaman", meeting: record.subject, message: `Gagal finalize rekaman (audio mungkin tidak utuh): ${err.message}` });
    db.updateMeeting(record.id, { status: "error", error: `Gagal finalize rekaman: ${err.message}` });
    return false;
  }
}

async function stopActiveRecording(record) {
  logger.info(`Waktu rapat "${record.subject}" selesai, menghentikan rekaman otomatis...`);
  if (!(await finalizeActiveRecording(record))) return;
  await finishAndProcess(record.id);
}

/**
 * Meeting `record` sudah waktunya direkam, tapi masih ada rekaman LAIN yang berjalan (mic &
 * BlackHole cuma bisa merekam 1 meeting sekaligus). Insiden nyata: meeting A molor lewat
 * jadwal, meeting B (jadwal berikutnya) sudah mulai -> B tidak pernah terekam, audionya malah
 * menyatu di rekaman A. Aturan:
 *  1. A sudah LEWAT jadwal selesainya (overtime) -> serah-terima: rekaman A dipotong DI SINI,
 *     A diproses (transkrip+notulen) di background, B langsung mulai direkam. Alasannya: A
 *     sudah lewat jadwal sementara B sudah mulai, hampir pasti Anda sudah pindah ke B.
 *  2. A MASIH dalam jadwalnya (jadwal benar-benar tumpang tindih) -> rekaman A TIDAK
 *     diganggu (tidak bisa tahu meeting mana yang Anda hadiri). B tetap `scheduled` sehingga
 *     otomatis mulai begitu A berhenti selama B belum berakhir, dan Anda diberi peringatan
 *     SEKALI supaya tahu B belum direkam.
 */
async function handleRecordingConflict(record, startMs, now) {
  const activeId = recorder.getActiveMeetingId();
  const active = activeId ? db.getMeeting(activeId) : null;
  if (!active || active.id === record.id) return;

  const activeEndMs = active.end ? new Date(active.end).getTime() : null;
  const activeIsOvertime = activeEndMs !== null && now >= activeEndMs;

  if (activeIsOvertime) {
    logger.warn(
      `Rapat "${active.subject}" molor lewat jadwal & rapat "${record.subject}" sudah mulai - rekaman "${active.subject}" dipotong sekarang, lanjut merekam "${record.subject}".`
    );
    recordAlert({
      level: "warning",
      kind: "rekaman",
      meeting: record.subject,
      message: `"${active.subject}" molor melewati jadwal selesai & "${record.subject}" sudah dimulai - rekaman dipecah di sini: "${active.subject}" diproses sendiri, "${record.subject}" mulai direkam.`,
    });
    if (await finalizeActiveRecording(active)) {
      // Proses transkrip+notulen A di background - JANGAN ditunggu supaya B tidak telat mulai
      // (transkripsi bisa makan beberapa menit).
      finishAndProcess(active.id).catch((err) =>
        logger.error(`Gagal memproses "${active.subject}" setelah serah-terima: ${err.message}`)
      );
    }
    return;
  }

  if (!record.conflictNotified) {
    db.updateMeeting(record.id, { conflictNotified: true });
    logger.warn(`Rapat "${record.subject}" bentrok dengan "${active.subject}" yang masih direkam - belum direkam.`);
    recordAlert({
      level: "warning",
      kind: "rekaman",
      meeting: record.subject,
      message: `Jadwal bentrok: "${record.subject}" sudah waktunya mulai, tapi "${active.subject}" masih direkam (hanya 1 rekaman sekaligus). "${record.subject}" akan otomatis direkam begitu "${active.subject}" selesai kalau masih berlangsung. Untuk merekam yang ini, hentikan rekaman yang sedang berjalan.`,
    });
  }
}

async function checkAndAct() {
  try {
    selfHealClaudeCliIfRelevant();

    // --- Reconcile / jaring pengaman ---
    // Cek apakah ada rekaman aktif yang SEHARUSNYA sudah berhenti (sudah lewat jadwal
    // selesai meeting), tapi timer auto-stop-nya "hilang" - ini bisa terjadi kalau proses
    // watcher sempat restart di tengah rekaman (mis. Mac restart, tray di-restart manual,
    // atau proses crash), karena setTimeout hanya hidup selama proses Node itu berjalan.
    // Dengan cek ini di SETIAP siklus polling (bukan cuma sekali via setTimeout), rekaman
    // yang "ketinggalan" akan otomatis dihentikan maksimal dalam WATCH_INTERVAL_MINUTES,
    // bukan berjalan terus tanpa batas.
    if (recorder.isRecording()) {
      const activeId = recorder.getActiveMeetingId();
      const activeRecord = activeId ? db.getMeeting(activeId) : null;
      if (activeRecord && activeRecord.status === "recording" && activeRecord.end) {
        const endMs = new Date(activeRecord.end).getTime();
        const graceMs = 60 * 1000; // buffer 1 menit, sama seperti jadwal auto-stop normal
        // Jaring pengaman ini HARUS ikut cek Teams/overtime juga (bukan cuma waktu) - kalau
        // tidak, meeting yang molor & sedang diperpanjang scheduleAutoStop() bisa langsung
        // dipotong paksa di sini begitu watcher sempat restart di tengah perpanjangan.
        if (Date.now() >= endMs + graceMs && !shouldExtendPastSchedule(endMs)) {
          logger.warn(
            `Rekaman "${activeRecord.subject}" melewati jadwal selesai (Teams sudah tidak berjalan, atau timer auto-stop hilang karena watcher sempat restart) - menghentikan sekarang.`
          );
          await stopActiveRecording(activeRecord);
        }
      }
    }

    // Fetch kalender dibungkus try/catch TERPISAH dari sisanya (bukan cuma andalkan catch di
    // luar) supaya "gagal fetch kalender" bisa dibedakan dari error lain, dan tercatat ke
    // watcher-meta.json untuk ditampilkan sebagai peringatan di tray - fetch yang gagal diam-diam
    // berjam-jam (mis. laptop sempat tidur/lepas WiFi) sebelumnya baru ketahuan setelah ada
    // meeting yang terlewat.
    let meetings;
    try {
      meetings = await getUpcomingTeamsMeetings({
        minutesAhead: config.watch.leadMinutes + config.watch.intervalMinutes + 5,
      });
      updateWatcherMeta({
        lastCalendarCheckAt: new Date().toISOString(),
        lastCalendarOk: true,
        lastCalendarSuccessAt: new Date().toISOString(),
        lastCalendarError: null,
        consecutiveCalendarFailures: 0,
      });
    } catch (err) {
      const prevFailures = readWatcherMeta().consecutiveCalendarFailures || 0;
      updateWatcherMeta({
        lastCalendarCheckAt: new Date().toISOString(),
        lastCalendarOk: false,
        lastCalendarError: err.message,
        consecutiveCalendarFailures: prevFailures + 1,
      });
      throw err;
    }

    const now = Date.now();

    for (const m of meetings) {
      const startMs = new Date(m.start).getTime();
      const endMs = new Date(m.end).getTime();
      const leadMs = config.watch.leadMinutes * 60 * 1000;

      let record = db.findByGraphEventId(m.graphEventId);
      if (!record) {
        record = db.addMeeting({
          id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          graphEventId: m.graphEventId,
          subject: m.subject,
          start: m.start,
          end: m.end,
          joinUrl: m.joinUrl,
          status: "scheduled",
        });
        logger.info(
          `Meeting terdeteksi di kalender: "${m.subject}" (${m.start})`
        );
      }

      const dueToStart = record.status === "scheduled" && now >= startMs - leadMs && now < endMs;
      if (dueToStart && recorder.isRecording()) {
        await handleRecordingConflict(record, startMs, now);
      }
      const shouldStart = dueToStart && !recorder.isRecording();

      if (shouldStart) {
        // Gate: kalau Teams sama sekali tidak berjalan saat jadwal mulai, kemungkinan besar
        // meeting ini di-cancel/reschedule tapi event lama masih ada di kalender - batalkan
        // auto-record daripada merekam apapun yang kebetulan terjadi di dekat mic.
        if (config.detection.requireTeamsRunning && !isTeamsRunning()) {
          logger.warn(
            `Meeting "${m.subject}" dijadwalkan mulai, tapi Microsoft Teams tidak sedang berjalan - auto-record dibatalkan.`
          );
          db.updateMeeting(record.id, {
            status: "skipped",
            skipReason: "Microsoft Teams tidak berjalan saat jadwal mulai",
          });
          continue;
        }

        logger.title(`MULAI REKAM: ${m.subject}`);
        const outputFile = recorder.startRecording(record.id, m.subject);
        db.updateMeeting(record.id, {
          status: "recording",
          audioFile: outputFile,
          recordingStartedAt: new Date().toISOString(),
        });

        // Jadwalkan auto-stop tepat saat waktu selesai meeting (+ buffer 1 menit) - ini
        // "fast path" (stop tepat waktu tanpa nunggu siklus polling berikutnya). Kalau proses
        // watcher restart sebelum timer ini sempat jalan, mekanisme reconcile di atas akan
        // jadi jaring pengaman (stop maksimal telat WATCH_INTERVAL_MINUTES). Kalau meeting
        // molor dari jadwal (Teams masih berjalan), scheduleAutoStop() memperpanjang otomatis
        // alih-alih memotong rekaman di tengah meeting - lihat shouldExtendPastSchedule().
        const stopInMs = endMs - now + 60 * 1000;
        scheduleAutoStop(record, endMs, Math.max(stopInMs, 5000));

        scheduleSilenceCheck(record, recorder.getActiveState(), Math.max(stopInMs, 5000));
      }
    }
  } catch (err) {
    logger.error(`Watcher error: ${err.message}`);
  }
}

async function finishAndProcess(meetingId) {
  const record = db.updateMeeting(meetingId, { status: "processing" });
  if (!record) {
    logger.error(
      `Meeting dengan ID "${meetingId}" tidak ditemukan di database - proses transkrip/notulen dibatalkan.`
    );
    return;
  }
  logger.info(`Memproses transkripsi & notulen untuk meeting: ${record.subject}`);
  try {
    await runPipelineForMeeting(record);
  } catch (err) {
    logger.error(`Gagal memproses meeting ${record.subject}: ${err.message}`);
    recordAlert({ level: "error", kind: "proses", meeting: record.subject, message: err.message });
    db.updateMeeting(meetingId, { status: "error", error: err.message });
  }
}

function startWatcher() {
  logger.title("MEETRESULT WATCHER AKTIF");
  logger.info(
    `Memantau kalender Outlook setiap ${config.watch.intervalMinutes} menit. Tekan Ctrl+C untuk berhenti.`
  );
  logger.info(
    `Retensi audio: file rekaman otomatis dihapus setelah ${config.retention.audioDays} hari.`
  );

  checkAndAct();
  cleanupOldRecordings();

  const cronExpr = `*/${config.watch.intervalMinutes} * * * *`;
  cron.schedule(cronExpr, checkAndAct);

  // Cek retensi audio setiap hari jam 03:00
  cron.schedule("0 3 * * *", cleanupOldRecordings);
}

module.exports = { startWatcher, checkAndAct, finishAndProcess };
