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

let stopTimer = null;

/**
 * Hentikan rekaman aktif TANPA lanjut ke transkrip+notulen - dipakai saat mekanisme deteksi
 * (lihat scheduleSilenceCheck()) menyimpulkan ini kemungkinan besar BUKAN meeting aktif,
 * supaya percakapan pribadi/audio di luar meeting tidak ikut ditranskrip & dirangkum AI.
 * File audio & transkrip tetap tersimpan (mengikuti retensi normal) untuk referensi manual.
 */
async function stopAndDiscardRecording(record, reason) {
  logger.warn(`Rekaman "${record.subject}" dihentikan otomatis: ${reason}`);
  const state = recorder.stopRecording();
  if (state) {
    const finalAudioFile = await recorder.finalizeRecording(state);
    if (finalAudioFile) {
      db.updateMeeting(record.id, { audioFile: finalAudioFile });
    }
  }
  db.updateMeeting(record.id, { status: "skipped", skipReason: reason });
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
  }, checkInMs);
}

/**
 * Hentikan rekaman aktif untuk 1 meeting record, gabungkan audio, lalu lanjut ke
 * pipeline transkrip+notulen. Dipakai baik oleh setTimeout auto-stop (fast path)
 * maupun oleh mekanisme reconcile di checkAndAct() (jaring pengaman).
 */
async function stopActiveRecording(record) {
  logger.info(`Waktu rapat "${record.subject}" selesai, menghentikan rekaman otomatis...`);
  const state = recorder.stopRecording();
  if (state) {
    const finalAudioFile = await recorder.finalizeRecording(state);
    if (finalAudioFile) {
      db.updateMeeting(record.id, { audioFile: finalAudioFile });
    }
  }
  await finishAndProcess(record.id);
}

async function checkAndAct() {
  try {
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
        if (Date.now() >= endMs + graceMs) {
          logger.warn(
            `Rekaman "${activeRecord.subject}" melewati jadwal selesai (kemungkinan timer auto-stop hilang karena watcher sempat restart) - menghentikan sekarang.`
          );
          await stopActiveRecording(activeRecord);
        }
      }
    }

    const meetings = await getUpcomingTeamsMeetings({
      minutesAhead: config.watch.leadMinutes + config.watch.intervalMinutes + 5,
    });

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

      const shouldStart =
        record.status === "scheduled" &&
        now >= startMs - leadMs &&
        now < endMs &&
        !recorder.isRecording();

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
        // jadi jaring pengaman (stop maksimal telat WATCH_INTERVAL_MINUTES).
        const stopInMs = endMs - now + 60 * 1000;
        setTimeout(async () => {
          if (recorder.getActiveMeetingId() === record.id) {
            await stopActiveRecording(record);
          }
        }, Math.max(stopInMs, 5000));

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
