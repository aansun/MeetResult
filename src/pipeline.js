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

/**
 * Pipeline lengkap: audio -> transkrip (Whisper) -> notulen (Claude)
 */
async function runPipelineForMeeting(meetingRecord) {
  if (!meetingRecord.audioFile) {
    throw new Error("Meeting ini belum memiliki file audio.");
  }

  const transcriptFile = await transcribeAudio(meetingRecord.audioFile);
  db.updateMeeting(meetingRecord.id, { transcriptFile, status: "transcribed" });

  const summaryFile = await summarizeFile(transcriptFile, {
    subject: meetingRecord.subject,
    start: meetingRecord.start,
    // Waktu mulai-selesai rapat, diambil langsung dari jadwal kalender (bukan dari jam
    // rekaman aktual, supaya konsisten dengan undangan meeting) - dipakai skema
    // "meeting_minutes" untuk field meetingTime.
    time: formatMeetingTimeRange(meetingRecord.start, meetingRecord.end) || undefined,
    media: "Online Meeting - Microsoft Teams",
  });
  db.updateMeeting(meetingRecord.id, { summaryFile, status: "done" });

  logger.success(`Selesai! Notulen rapat "${meetingRecord.subject}" siap dilihat.`);
  return { transcriptFile, summaryFile };
}

module.exports = { runPipelineForMeeting };
