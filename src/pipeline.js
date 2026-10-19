const fs = require("fs");
const logger = require("./utils/logger");
const db = require("./storage/db");
const { transcribeAudio } = require("./transcribe/transcriber");
const { summarizeFile } = require("./summarize/summarizer");

// Indonesia cuma punya 3 zona waktu - dipetakan dari UTC offset sistem (bukan dari data ICU
// yang belum tentu tersedia lengkap di semua environment Node).
function indonesianTimeZoneAbbr(date) {
  const offsetHours = -date.getTimezoneOffset() / 60;
  if (offsetHours === 7) return "WIB";
  if (offsetHours === 8) return "WITA";
  if (offsetHours === 9) return "WIT";
  return "";
}

/**
 * Format rentang waktu meeting dari start/end kalender, mis. "10:00 - 11:00 WITA".
 * null kalau salah satu tidak tersedia/tidak valid.
 */
function formatMeetingTimeRange(startIso, endIso) {
  if (!startIso || !endIso) return null;
  const start = new Date(startIso);
  const end = new Date(endIso);
  if (isNaN(start) || isNaN(end)) return null;

  const fmt = (d) => `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  const tz = indonesianTimeZoneAbbr(start);
  return `${fmt(start)} - ${fmt(end)}${tz ? " " + tz : ""}`;
}

function summarizeForMeeting(meetingRecord, transcriptFile) {
  return summarizeFile(transcriptFile, {
    subject: meetingRecord.subject,
    start: meetingRecord.start,
    // Waktu mulai-selesai rapat, diambil langsung dari jadwal kalender (bukan dari jam
    // rekaman aktual, supaya konsisten dengan undangan meeting) - dipakai skema
    // "meeting_minutes" untuk field meetingTime.
    time: formatMeetingTimeRange(meetingRecord.start, meetingRecord.end) || undefined,
    media: "Online Meeting - Microsoft Teams",
  });
}

/**
 * Pipeline lengkap: audio -> transkrip (Whisper) -> notulen (Claude)
 */
async function runPipelineForMeeting(meetingRecord) {
  if (!meetingRecord.audioFile) {
    throw new Error("Meeting ini belum memiliki file audio.");
  }

  const transcriptFile = await transcribeAudio(meetingRecord.audioFile);
  db.updateMeeting(meetingRecord.id, { transcriptFile, status: "transcribed" });

  const summaryFile = await summarizeForMeeting(meetingRecord, transcriptFile);
  db.updateMeeting(meetingRecord.id, { summaryFile, status: "done" });

  logger.success(`Selesai! Notulen rapat "${meetingRecord.subject}" siap dilihat.`);
  return { transcriptFile, summaryFile };
}

/**
 * Ulangi proses meeting yang gagal/macet, mulai dari titik yang masih bisa dipakai: kalau
 * transkrip sudah ada (dan tidak dipaksa), cuma notulen yang dibuat ulang - tidak perlu
 * transkripsi ulang (lambat & kena kuota provider). Transkripsi ulang dari audio hanya kalau
 * transkrip belum ada ATAU `forceTranscribe` (mis. hasil transkrip lama jelek).
 */
async function retryPipelineForMeeting(meetingRecord, { forceTranscribe = false } = {}) {
  const hasAudio = !!meetingRecord.audioFile && fs.existsSync(meetingRecord.audioFile);
  const hasTranscript = !!meetingRecord.transcriptFile && fs.existsSync(meetingRecord.transcriptFile);

  if (!hasAudio && !hasTranscript) {
    throw new Error("Audio maupun transkrip sudah tidak ada - meeting ini tidak bisa diproses ulang.");
  }

  let transcriptFile = meetingRecord.transcriptFile;
  if (forceTranscribe || !hasTranscript) {
    if (!hasAudio) {
      throw new Error("Audio sudah dihapus (retensi) - hanya bisa membuat ulang notulen dari transkrip yang ada.");
    }
    transcriptFile = await transcribeAudio(meetingRecord.audioFile);
    db.updateMeeting(meetingRecord.id, { transcriptFile, status: "transcribed" });
  }

  const summaryFile = await summarizeForMeeting(meetingRecord, transcriptFile);
  db.updateMeeting(meetingRecord.id, { summaryFile, status: "done", error: null });

  logger.success(`Selesai! Notulen rapat "${meetingRecord.subject}" siap dilihat.`);
  return { transcriptFile, summaryFile };
}

module.exports = { runPipelineForMeeting, retryPipelineForMeeting };
