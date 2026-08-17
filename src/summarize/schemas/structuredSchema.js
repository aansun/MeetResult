/**
 * Skema "structured" (default) — MoM dengan tabel Pembahasan & Kesepakatan + Action Items.
 * Cocok untuk rapat progress/review project mingguan, dsb.
 * Template terkait: Template/mom_template.docx
 */

const SYSTEM_PROMPT = `Kamu adalah asisten notulen rapat profesional yang sangat mahir berbahasa Indonesia.
Tugasmu membaca transkrip rapat (mungkin campuran Bahasa Indonesia/Inggris) dan menghasilkan data
Minutes of Meeting (MoM) dalam format JSON SAJA, tanpa markdown, tanpa penjelasan tambahan, tanpa code fence.

Skema JSON WAJIB persis seperti ini:
{
  "subject": "judul singkat rapat",
  "participants": "daftar nama/peran peserta yang teridentifikasi, dipisah koma. Jika tidak diketahui, tulis 'Tidak disebutkan dalam transkrip'",
  "discussion": [
    { "no": 1, "topic": "topik singkat", "status": "ringkasan status/pembahasan", "agreement": "kesepakatan/keputusan terkait topik ini" }
  ],
  "actionItems": [
    { "no": 1, "item": "deskripsi tindak lanjut", "pic": "penanggung jawab (atau 'Tidak disebutkan')", "target": "tenggat waktu (atau 'Tidak disebutkan')" }
  ],
  "notes": "catatan tambahan penting, risiko, atau isu terbuka (opsional, boleh string kosong)"
}

Aturan:
- Semua isi teks WAJIB Bahasa Indonesia yang rapi dan profesional.
- Jangan mengarang informasi yang tidak ada di transkrip. Jika tidak ada, tulis "Tidak disebutkan dalam transkrip".
- discussion dan actionItems minimal berisi 1 item.
- Keluarkan HANYA objek JSON valid, tanpa teks lain di luar JSON.`;

function buildUserPrompt(transcriptText, meetingMeta = {}) {
  return `Judul rapat: ${meetingMeta.subject || "(tidak diketahui, tentukan dari transkrip)"}
Media: ${meetingMeta.media || "Microsoft Teams (Online Meeting)"}

Berikut transkrip rapat:
"""
${transcriptText}
"""

Hasilkan JSON MoM sesuai skema yang telah ditentukan.`;
}

/**
 * Mapping hasil JSON Claude -> data yang dipakai untuk render template .docx
 */
function mapToTemplateData(momJson, meetingMeta, formatIndonesianDateLabel, preparedBy, media) {
  const discussion = (momJson.discussion || []).map((d, i) => ({
    no: d.no || i + 1,
    topic: d.topic || "-",
    status: d.status || "-",
    agreement: d.agreement || "-",
  }));

  const actionItems = (momJson.actionItems || []).map((a, i) => ({
    no: a.no || i + 1,
    item: a.item || "-",
    pic: a.pic || "-",
    target: a.target || "-",
  }));

  return {
    subject: momJson.subject || meetingMeta.subject || "Meeting",
    dateLabel: formatIndonesianDateLabel(meetingMeta.start),
    media: media,
    participants: momJson.participants || meetingMeta.participants || "Tidak disebutkan dalam transkrip",
    preparedBy,
    discussion,
    actionItems,
    notes: momJson.notes || "",
  };
}

module.exports = { SYSTEM_PROMPT, buildUserPrompt, mapToTemplateData };
