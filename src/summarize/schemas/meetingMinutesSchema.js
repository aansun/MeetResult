/**
 * Skema "meeting_minutes" — format narasi Resume bernomor + tabel Attendances.
 * Cocok untuk rapat formal/audit/review kebijakan (mis. Review SOP, ISO, dsb).
 * Template terkait: Template/mom_meeting_minutes_template.docx
 */

const SYSTEM_PROMPT = `Kamu adalah asisten notulen rapat profesional yang sangat mahir berbahasa Indonesia,
terbiasa membuat "Meeting Minutes" format formal/korporat (mis. untuk rapat audit, review kebijakan/SOP).

Tugasmu membaca transkrip rapat dan menghasilkan data dalam format JSON SAJA, tanpa markdown,
tanpa penjelasan tambahan, tanpa code fence.

Skema JSON WAJIB persis seperti ini:
{
  "meetingTitle": "judul singkat rapat",
  "resume": [
    {
      "no": 1,
      "point": "kalimat poin utama pembahasan (tanpa nomor)",
      "subpoints": ["sub-poin a", "sub-poin b", "..."]
    }
  ],
  "attendees": [
    { "no": 1, "name": "nama peserta", "company": "nama perusahaan/instansi (atau 'Tidak disebutkan')", "position": "jabatan/departemen (atau 'Tidak disebutkan')" }
  ]
}

Aturan:
- Semua isi teks WAJIB Bahasa Indonesia yang rapi, formal, dan profesional (gaya notulen resmi korporat).
- "resume" adalah rangkuman poin-poin utama pembahasan rapat secara naratif dan terstruktur (bukan dialog verbatim).
  Setiap poin utama boleh punya beberapa sub-poin penjelas jika relevan (boleh array kosong jika tidak perlu).
- "attendees": ekstrak nama-nama peserta yang disebutkan/memperkenalkan diri dalam transkrip.
  Jika perusahaan/jabatan tidak disebutkan, isi "Tidak disebutkan".
- Jangan mengarang informasi yang tidak ada di transkrip.
- resume minimal berisi 1 item. attendees boleh array kosong jika benar-benar tidak ada nama disebut.
- Keluarkan HANYA objek JSON valid, tanpa teks lain di luar JSON.`;

function buildUserPrompt(transcriptText, meetingMeta = {}) {
  return `Judul rapat: ${meetingMeta.subject || "(tidak diketahui, tentukan dari transkrip)"}
Lokasi/Media: ${meetingMeta.location || meetingMeta.media || "Online Meeting - Microsoft Teams"}

Berikut transkrip rapat:
"""
${transcriptText}
"""

Hasilkan JSON Meeting Minutes sesuai skema yang telah ditentukan.`;
}

/**
 * Mapping hasil JSON Claude -> data yang dipakai untuk render template .docx
 */
function mapToTemplateData(momJson, meetingMeta, formatIndonesianDateLabel, preparedBy, media) {
  const resume = (momJson.resume || []).map((r, i) => {
    const subpoints = r.subpoints || [];
    const subpointsText = subpoints
      .map((s, idx) => `${String.fromCharCode(97 + idx)}. ${s}`)
      .join("\n");
    return {
      no: r.no || i + 1,
      point: r.point || "-",
      subpointsText,
    };
  });

  const attendees = (momJson.attendees || []).map((a, i) => ({
    no: a.no || i + 1,
    name: a.name || "-",
    company: a.company || "Tidak disebutkan",
    position: a.position || "Tidak disebutkan",
  }));

  return {
    meetingTitle: momJson.meetingTitle || meetingMeta.subject || "Meeting",
    meetingDate: formatIndonesianDateLabel(meetingMeta.start),
    meetingTime: meetingMeta.time || "Tidak disebutkan",
    meetingLocation: meetingMeta.location || media,
    resume,
    attendees,
    notes:
      meetingMeta.notes ||
      "Catatan: Notulen ini dihasilkan otomatis oleh MeetResult berdasarkan transkripsi rapat.",
  };
}

module.exports = { SYSTEM_PROMPT, buildUserPrompt, mapToTemplateData };
