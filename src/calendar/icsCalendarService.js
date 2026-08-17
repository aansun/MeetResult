const ical = require("node-ical");
const config = require("../config/config");
const logger = require("../utils/logger");

// Regex umum untuk menangkap link join Microsoft Teams di deskripsi event
const TEAMS_LINK_REGEX = /https:\/\/teams\.microsoft\.com\/l\/meetup-join\/[^\s"<>]+/i;

/**
 * Ambil meeting dari feed ICS (webcal) yang dipublish dari Outlook Web.
 * Tidak butuh login OAuth / Azure App Registration.
 *
 * Cara mendapatkan URL:
 *  Outlook Web > Settings > Calendar > Shared calendars > Publish a calendar
 *  > pilih "Can view all details" > copy link "ICS"
 */
async function getUpcomingTeamsMeetings({ minutesAhead = 60 } = {}) {
  if (!config.ics.url) {
    throw new Error(
      "CALENDAR_ICS_URL belum diisi di .env. Lihat README bagian 'Setup Kalender (Mode ICS)'."
    );
  }

  const events = await ical.async.fromURL(config.ics.url);
  const now = new Date();
  const end = new Date(now.getTime() + minutesAhead * 60 * 1000);

  const result = [];

  for (const key in events) {
    const ev = events[key];
    if (ev.type !== "VEVENT") continue;

    const start = ev.start ? new Date(ev.start) : null;
    const finish = ev.end ? new Date(ev.end) : null;
    if (!start || !finish) continue;

    // Sertakan meeting yang AKAN datang (dalam window minutesAhead) MAUPUN yang
    // SEDANG BERLANGSUNG saat ini (sudah mulai tapi belum selesai) - supaya watcher
    // tetap bisa mendeteksi & mulai rekam meeting yang baru saja berjalan.
    const isUpcoming = start >= now && start <= end;
    const isOngoing = start < now && finish > now;
    if (!isUpcoming && !isOngoing) continue;

    const description = ev.description || "";
    const location = ev.location || "";
    const combinedText = `${description}\n${location}`;
    const isTeams =
      /microsoft teams meeting/i.test(combinedText) ||
      TEAMS_LINK_REGEX.test(combinedText);

    if (!isTeams) continue;

    const match = combinedText.match(TEAMS_LINK_REGEX);

    result.push({
      graphEventId: ev.uid || `${ev.summary}-${start.toISOString()}`,
      subject: ev.summary || "(Tanpa judul)",
      organizer: ev.organizer?.params?.CN || ev.organizer?.val || "",
      start: start.toISOString(),
      end: finish.toISOString(),
      timeZone: "local",
      joinUrl: match ? match[0] : null,
      attendees: (ev.attendee
        ? Array.isArray(ev.attendee)
          ? ev.attendee
          : [ev.attendee]
        : []
      ).map((a) => a.params?.CN || a.val),
    });
  }

  return result.sort((a, b) => new Date(a.start) - new Date(b.start));
}

module.exports = { getUpcomingTeamsMeetings };
