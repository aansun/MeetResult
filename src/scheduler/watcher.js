const cron = require("node-cron");
const config = require("../config/config");
const logger = require("../utils/logger");
const db = require("../storage/db");
const recorder = require("../recorder/recorder");
const { getUpcomingTeamsMeetings } = require("../calendar");
const { runPipelineForMeeting } = require("../pipeline");
const { cleanupOldRecordings } = require("../utils/retention");

let stopTimer = null;

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
