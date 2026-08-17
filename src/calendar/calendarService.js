const axios = require("axios");
const { getAccessToken } = require("../auth/outlookAuth");

const GRAPH_BASE = "https://graph.microsoft.com/v1.0";

/**
 * Ambil daftar event kalender Outlook dalam rentang waktu tertentu,
 * hanya yang merupakan Teams meeting (isOnlineMeeting = true, onlineMeetingProvider teamsForBusiness).
 */
async function getUpcomingTeamsMeetings({ minutesAhead = 60 } = {}) {
  const token = await getAccessToken();
  const now = new Date();
  const end = new Date(now.getTime() + minutesAhead * 60 * 1000);

  const url =
    `${GRAPH_BASE}/me/calendarView` +
    `?startDateTime=${encodeURIComponent(now.toISOString())}` +
    `&endDateTime=${encodeURIComponent(end.toISOString())}` +
    `&$orderby=start/dateTime` +
    `&$top=50`;

  const { data } = await axios.get(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Prefer: 'outlook.timezone="SE Asia Standard Time"',
    },
  });

  const events = data.value || [];
  return events
    .filter(
      (ev) =>
        ev.isOnlineMeeting &&
        (ev.onlineMeetingProvider === "teamsForBusiness" ||
          (ev.onlineMeeting && ev.onlineMeeting.joinUrl))
    )
    .map((ev) => ({
      graphEventId: ev.id,
      subject: ev.subject,
      organizer: ev.organizer?.emailAddress?.name || "",
      start: ev.start?.dateTime,
      end: ev.end?.dateTime,
      timeZone: ev.start?.timeZone,
      joinUrl: ev.onlineMeeting?.joinUrl || null,
      attendees: (ev.attendees || []).map(
        (a) => a.emailAddress?.name || a.emailAddress?.address
      ),
    }));
}

module.exports = { getUpcomingTeamsMeetings };
