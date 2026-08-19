const ical = require("node-ical");
const config = require("../config/config");

// Regex umum untuk menangkap link join Microsoft Teams di deskripsi event
const TEAMS_LINK_REGEX = /https:\/\/teams\.microsoft\.com\/l\/meetup-join\/[^\s"<>]+/i;

function isTeamsMeeting(ev) {
  const description = ev.description || "";
  const location = ev.location || "";
  const combinedText = `${description}\n${location}`;
  return /microsoft teams meeting/i.test(combinedText) || TEAMS_LINK_REGEX.test(combinedText);
}

function extractJoinUrl(ev) {
  const description = ev.description || "";
  const location = ev.location || "";
  const combinedText = `${description}\n${location}`;
  const match = combinedText.match(TEAMS_LINK_REGEX);
  return match ? match[0] : null;
}

function buildGraphEventId(ev, start) {
  if (!ev.uid) return `${ev.summary}-${start.toISOString()}`;
  // Occurrence dari event BERULANG (hasil expand RRULE, atau override 1 instance) perlu ID
  // unik PER KEJADIAN, karena semuanya berbagi UID yang sama dengan induknya - kalau cuma
  // pakai UID polos, hanya kejadian pertama yang akan pernah tercatat di db.json dan minggu-
  // minggu berikutnya tidak akan pernah kedeteksi ulang.
  if (ev.rrule || ev.recurrenceid) return `${ev.uid}-${start.toISOString()}`;
  return ev.uid;
}

function toMeetingEntry(ev, start, finish) {
  return {
    graphEventId: buildGraphEventId(ev, start),
    subject: ev.summary || "(Tanpa judul)",
    organizer: ev.organizer?.params?.CN || ev.organizer?.val || "",
    start: start.toISOString(),
    end: finish.toISOString(),
    timeZone: "local",
    joinUrl: extractJoinUrl(ev),
    attendees: (ev.attendee
      ? Array.isArray(ev.attendee)
        ? ev.attendee
        : [ev.attendee]
      : []
    ).map((a) => a.params?.CN || a.val),
  };
}

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
  const windowEnd = new Date(now.getTime() + minutesAhead * 60 * 1000);

  // Occurrence individual (override) dari event berulang punya `recurrenceid` yang menunjuk
  // tanggal kejadian aslinya - dicatat per UID+tanggal supaya kejadian itu tidak dobel dihitung
  // lagi saat expand RRULE induknya di bawah.
  const overriddenOccurrences = new Set();
  for (const key in events) {
    const ev = events[key];
    if (ev.type !== "VEVENT" || !ev.recurrenceid || !ev.uid) continue;
    overriddenOccurrences.add(`${ev.uid}|${new Date(ev.recurrenceid).getTime()}`);
  }

  const result = [];

  for (const key in events) {
    const ev = events[key];
    if (ev.type !== "VEVENT") continue;
    if (!isTeamsMeeting(ev)) continue;

    if (ev.rrule) {
      // Event BERULANG (mingguan/harian/dst) - WAJIB expand RRULE untuk cari kejadian yang
      // jatuh di window sekarang. Kalau cuma pakai ev.start (tanggal kejadian pertama saat
      // event dibuat), meeting berulang cuma pernah "kedeteksi" sekali seumur hidup.
      const masterStart = ev.start ? new Date(ev.start) : null;
      const masterEnd = ev.end ? new Date(ev.end) : null;
      if (!masterStart || !masterEnd) continue;
      const durationMs = masterEnd.getTime() - masterStart.getTime();

      // Mundur selebar durasi meeting dari "now" supaya kejadian yang SUDAH mulai tapi
      // BELUM selesai (ongoing) ikut tertangkap oleh rrule.between().
      const rangeStart = new Date(now.getTime() - durationMs);
      const occurrences = ev.rrule.between(rangeStart, windowEnd, true);
      if (occurrences.length === 0) continue;

      const exdateTimes = new Set(
        Object.values(ev.exdate || {}).map((d) => new Date(d).getTime())
      );

      for (const occStart of occurrences) {
        if (exdateTimes.has(occStart.getTime())) continue; // kejadian ini di-cancel (EXDATE)
        if (ev.uid && overriddenOccurrences.has(`${ev.uid}|${occStart.getTime()}`)) continue; // sudah ditangani sbg override di bawah

        const occEnd = new Date(occStart.getTime() + durationMs);
        const isUpcoming = occStart >= now && occStart <= windowEnd;
        const isOngoing = occStart < now && occEnd > now;
        if (!isUpcoming && !isOngoing) continue;

        result.push(toMeetingEntry(ev, occStart, occEnd));
      }
      continue;
    }

    // Event biasa (bukan berulang), ATAU 1 kejadian yang di-override dari sebuah seri berulang
    // (punya ev.recurrenceid + start/end sendiri yang beda dari jadwal aslinya)
    const start = ev.start ? new Date(ev.start) : null;
    const finish = ev.end ? new Date(ev.end) : null;
    if (!start || !finish) continue;

    // Sertakan meeting yang AKAN datang (dalam window minutesAhead) MAUPUN yang
    // SEDANG BERLANGSUNG saat ini (sudah mulai tapi belum selesai) - supaya watcher
    // tetap bisa mendeteksi & mulai rekam meeting yang baru saja berjalan.
    const isUpcoming = start >= now && start <= windowEnd;
    const isOngoing = start < now && finish > now;
    if (!isUpcoming && !isOngoing) continue;

    result.push(toMeetingEntry(ev, start, finish));
  }

  return result.sort((a, b) => new Date(a.start) - new Date(b.start));
}

module.exports = { getUpcomingTeamsMeetings };
