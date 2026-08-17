const config = require("../config/config");

/**
 * Router kalender: pilih implementasi sesuai CALENDAR_MODE di .env
 * - "graph": Microsoft Graph API (butuh Azure App Registration + login)
 * - "ics"  : ICS/webcal feed dari Outlook Web (tanpa Azure App, tanpa login OAuth)
 */
function getCalendarService() {
  if (config.calendar.mode === "ics") {
    return require("./icsCalendarService");
  }
  return require("./calendarService");
}

module.exports = {
  getUpcomingTeamsMeetings: (...args) =>
    getCalendarService().getUpcomingTeamsMeetings(...args),
};
