const fs = require("fs");
const path = require("path");
const PizZip = require("pizzip");
const Docxtemplater = require("docxtemplater");
const config = require("../config/config");
const { injectLogo } = require("./docxLogoInjector");

/**
 * Cari file logo di folder Template/ (logo.jpeg / logo.jpg / logo.png).
 * File ini TIDAK di-commit ke git (lihat .gitignore) - hanya dipakai lokal
 * di komputer masing-masing untuk menyisipkan logo ke dokumen MoM yang dihasilkan.
 */
function findLocalLogoPath() {
  if (process.env.MOM_LOGO_PATH) {
    return path.resolve(config.ROOT_DIR, process.env.MOM_LOGO_PATH);
  }
  const candidates = ["logo.jpeg", "logo.jpg", "logo.png"];
  for (const name of candidates) {
    const p = path.join(config.ROOT_DIR, "Template", name);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

/**
 * Render dokumen dari file TEMPLATE .docx yang berisi placeholder/tag,
 * misalnya {subject}, {dateLabel}, atau {meetingTitle}, {resume}, dst
 * tergantung skema template yang dipakai. Jika template punya placeholder
 * "{%logo}" dan ada file logo lokal di Template/, logo akan disisipkan
 * otomatis (tidak pernah ikut ter-commit ke git).
 *
 * `data` adalah objek generik apa adanya (sudah disiapkan oleh masing-masing
 * schema di src/summarize/schemas/) — fungsi ini TIDAK mengasumsikan nama
 * field tertentu, supaya bisa dipakai untuk template MoM apa pun.
 */
function renderFromTemplate(templatePath, data, outputPath) {
  if (!fs.existsSync(templatePath)) {
    throw new Error(`Template tidak ditemukan: ${templatePath}`);
  }

  const content = fs.readFileSync(templatePath, "binary");
  const zip = new PizZip(content);

  // Sisipkan/hapus placeholder logo SEBELUM docxtemplater memproses tag biasa,
  // supaya "{%logo}" tidak dianggap tag yang belum di-resolve.
  injectLogo(zip, findLocalLogoPath());

  const doc = new Docxtemplater(zip, {
    paragraphLoop: true,
    linebreaks: true,
  });

  doc.render(data);

  const buffer = doc.getZip().generate({ type: "nodebuffer" });
  fs.writeFileSync(outputPath, buffer);
  return outputPath;
}

module.exports = { renderFromTemplate, findLocalLogoPath };
