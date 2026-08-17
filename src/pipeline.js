const logger = require("./utils/logger");
const db = require("./storage/db");
const { transcribeAudio } = require("./transcribe/transcriber");
const { summarizeFile } = require("./summarize/summarizer");

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
    media: "Online Meeting - Microsoft Teams",
  });
  db.updateMeeting(meetingRecord.id, { summaryFile, status: "done" });

  logger.success(`Selesai! Notulen rapat "${meetingRecord.subject}" siap dilihat.`);
  return { transcriptFile, summaryFile };
}

module.exports = { runPipelineForMeeting };
