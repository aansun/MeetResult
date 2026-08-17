const cron = require("node-cron");
const config = require("../config/config");
const logger = require("../utils/logger");
const db = require("../storage/db");
const recorder = require("../recorder/recorder");
const { getUpcomingTeamsMeetings } = require("../calendar");
const { runPipelineForMeeting } = require("../pipeline");
const { cleanupOldRecordings } = require("../utils/retention");

let stopTimer = null;

async function checkAndAct() {
  try {
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

        // Jadwalkan auto-stop tepat saat waktu selesai meeting (+ buffer 1 menit)
        const stopInMs = endMs - now + 60 * 1000;
        setTimeout(async () => {
          if (recorder.getActiveMeetingId() === record.id) {
            logger.info(`Waktu rapat "${m.subject}" selesai, menghentikan rekaman otomatis...`);
            const state = recorder.stopRecording();
            if (state) {
              const finalAudioFile = await recorder.finalizeRecording(state);
              if (finalAudioFile) {
                db.updateMeeting(record.id, { audioFile: finalAudioFile });
              }
            }
            finishAndProcess(record.id);
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
