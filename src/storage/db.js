const fs = require("fs");
const { DB_FILE } = require("../config/config");

function load() {
  if (!fs.existsSync(DB_FILE)) {
    return { meetings: [], settings: {} };
  }
  try {
    return JSON.parse(fs.readFileSync(DB_FILE, "utf-8"));
  } catch (e) {
    return { meetings: [], settings: {} };
  }
}

function save(db) {
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2), "utf-8");
}

function addMeeting(meeting) {
  const db = load();
  db.meetings.push(meeting);
  save(db);
  return meeting;
}

function updateMeeting(id, patch) {
  const db = load();
  const idx = db.meetings.findIndex((m) => m.id === id);
  if (idx === -1) return null;
  db.meetings[idx] = { ...db.meetings[idx], ...patch };
  save(db);
  return db.meetings[idx];
}

function getMeeting(id) {
  const db = load();
  return db.meetings.find((m) => m.id === id) || null;
}

function listMeetings() {
  return load().meetings;
}

function findByGraphEventId(graphEventId) {
  const db = load();
  return db.meetings.find((m) => m.graphEventId === graphEventId) || null;
}

module.exports = {
  load,
  save,
  addMeeting,
  updateMeeting,
  getMeeting,
  listMeetings,
  findByGraphEventId,
};
