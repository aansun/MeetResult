const fs = require("fs");
const { DB_FILE } = require("../config/config");
const { withFsRetry } = require("../utils/fsRetry");

function load() {
  if (!fs.existsSync(DB_FILE)) {
    return { meetings: [], settings: {} };
  }
  let raw;
  try {
    raw = withFsRetry(() => fs.readFileSync(DB_FILE, "utf-8"));
  } catch (e) {
    // JANGAN kembalikan database kosong di sini: pemanggil berikutnya (addMeeting/updateMeeting)
    // akan save() hasil kosong itu dan MENIMPA seluruh riwayat meeting. Lebih baik gagal keras.
    throw new Error(`Gagal membaca database ${DB_FILE}: ${e.message}`);
  }
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || !Array.isArray(parsed.meetings)) throw new Error("struktur tidak valid");
    return parsed;
  } catch (e) {
    // File ada tapi isinya rusak: simpan salinannya dulu (supaya bisa dipulihkan manual) baru
    // gagal keras - jangan diam-diam diganti database kosong.
    const backup = `${DB_FILE}.corrupt-${Date.now()}`;
    try {
      fs.writeFileSync(backup, raw, "utf-8");
    } catch (_) {}
    throw new Error(`Database rusak (${e.message}); salinan disimpan di ${backup}`);
  }
}

function save(db) {
  // Tulis ke file sementara lalu rename = atomik (tidak ada db.json setengah tertulis kalau
  // proses mati di tengah), dan diulang kalau kena error file sementara (EPERM/EBUSY).
  const tmp = `${DB_FILE}.tmp`;
  withFsRetry(() => {
    fs.writeFileSync(tmp, JSON.stringify(db, null, 2), "utf-8");
    fs.renameSync(tmp, DB_FILE);
  });
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
