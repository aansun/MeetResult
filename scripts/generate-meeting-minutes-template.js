/**
 * Membuat Template/mom_meeting_minutes_template.docx — varian template "Meeting Minutes"
 * (format Resume naratif bernomor + tabel Attendances), cocok untuk rapat formal/audit
 * seperti review kebijakan, SOP, atau rapat evaluasi resmi lainnya.
 *
 * Jalankan ulang untuk reset ke default:
 *   node scripts/generate-meeting-minutes-template.js
 */
const path = require("path");
const fs = require("fs");
const {
  Document,
  Packer,
  Paragraph,
  TextRun,
  Table,
  TableRow,
  TableCell,
  WidthType,
  AlignmentType,
  BorderStyle,
  ShadingType,
  LevelFormat,
} = require("docx");

const BORDER = {
  top: { style: BorderStyle.SINGLE, size: 2, color: "999999" },
  bottom: { style: BorderStyle.SINGLE, size: 2, color: "999999" },
  left: { style: BorderStyle.SINGLE, size: 2, color: "999999" },
  right: { style: BorderStyle.SINGLE, size: 2, color: "999999" },
};

// Padding di dalam sel tabel (twips, 1 inch = 1440 twips) supaya teks tidak mepet border
const CELL_MARGINS = {
  top: 80,
  bottom: 80,
  left: 100,
  right: 100,
};

function headerCell(text, widthPct) {
  return new TableCell({
    width: { size: widthPct, type: WidthType.PERCENTAGE },
    shading: { type: ShadingType.CLEAR, fill: "D9D9D9" },
    borders: BORDER,
    margins: CELL_MARGINS,
    children: [new Paragraph({ children: [new TextRun({ text, bold: true, size: 20, color: "404041" })] })],
  });
}

function bodyCell(text, widthPct) {
  return new TableCell({
    width: { size: widthPct, type: WidthType.PERCENTAGE },
    borders: BORDER,
    margins: CELL_MARGINS,
    children: [new Paragraph({ children: [new TextRun({ text, size: 20 })] })],
  });
}

function infoRow(label, tag) {
  return new TableRow({
    children: [
      new TableCell({
        width: { size: 25, type: WidthType.PERCENTAGE },
        borders: BORDER,
        margins: CELL_MARGINS,
        shading: { type: ShadingType.CLEAR, fill: "E7E6E6" },
        children: [new Paragraph({ children: [new TextRun({ text: label, bold: true, size: 20 })] })],
      }),
      new TableCell({
        width: { size: 75, type: WidthType.PERCENTAGE },
        borders: BORDER,
        margins: CELL_MARGINS,
        children: [new Paragraph({ children: [new TextRun({ text: tag, size: 20 })] })],
      }),
    ],
  });
}

const doc = new Document({
  numbering: {
    config: [
      {
        reference: "mom-resume",
        levels: [
          {
            level: 0,
            format: LevelFormat.DECIMAL,
            text: "%1.",
            alignment: AlignmentType.LEFT,
            style: { paragraph: { indent: { left: 426, hanging: 426 } }, run: { bold: true, size: 22 } },
          },
          {
            level: 1,
            format: LevelFormat.LOWER_LETTER,
            text: "%2.",
            alignment: AlignmentType.LEFT,
            style: { paragraph: { indent: { left: 852, hanging: 426 } }, run: { size: 22 } },
          },
        ],
      },
    ],
  },
  sections: [
    {
      properties: {
        page: {
          margin: { top: 720, bottom: 720, left: 720, right: 720 }, // 0.5 inch (default 1 inch)
        },
      },
      children: [
        // Placeholder logo (opsional). Disisipkan otomatis dari file lokal Template/logo.*
        // (tidak pernah ikut ter-commit ke git). Kalau tidak ada file logo, baris ini
        // otomatis dikosongkan saat generate dokumen.
        new Paragraph({
          alignment: AlignmentType.LEFT,
          spacing: { after: 120 },
          children: [new TextRun({ text: "{%logo}" })],
        }),
        new Paragraph({
          alignment: AlignmentType.CENTER,
          spacing: { after: 200 },
          children: [new TextRun({ text: "Meeting Minutes", bold: true, size: 28 })],
        }),

        new Table({
          width: { size: 100, type: WidthType.PERCENTAGE },
          rows: [
            infoRow("Meeting", "{meetingTitle}"),
            infoRow("Meeting Date", "{meetingDate}"),
            infoRow("Meeting Time", "{meetingTime}"),
            infoRow("Meeting Location", "{meetingLocation}"),
          ],
        }),

        new Paragraph({ text: "", spacing: { after: 200 } }),

        new Paragraph({
          children: [new TextRun({ text: "Resume:", bold: true, size: 24, color: "000000" })],
        }),

        // Loop narasi Resume: setiap item = 1 poin utama (nomor Word otomatis 1, 2, 3...) dengan
        // sub-poin di bawahnya (huruf Word otomatis a, b, c... yang mulai ulang di tiap poin
        // utama - satu daftar bertingkat). Tiap sub-poin = 1 paragraf sendiri lewat loop
        // {#subpoints}, jadi baris yang membungkus punya indentasi gantung (bukan teks biasa).
        // PENTING: tag buka/tutup loop WAJIB di paragraf terpisah dari paragraf isi, agar
        // docxtemplater menduplikasi paragraf isinya dengan benar per item.
        new Paragraph({
          children: [new TextRun({ text: "{#resume}", size: 2 })],
        }),
        new Paragraph({
          keepNext: true,
          numbering: { reference: "mom-resume", level: 0 },
          spacing: { before: 120, after: 60 },
          children: [new TextRun({ text: "{point}", size: 22, bold: true })],
        }),
        new Paragraph({
          children: [new TextRun({ text: "{#subpoints}", size: 2 })],
        }),
        new Paragraph({
          numbering: { reference: "mom-resume", level: 1 },
          spacing: { after: 60 },
          children: [new TextRun({ text: "{text}", size: 22 })],
        }),
        new Paragraph({
          children: [new TextRun({ text: "{/subpoints}", size: 2 })],
        }),
        new Paragraph({
          children: [new TextRun({ text: "{/resume}", size: 2 })],
        }),

        new Paragraph({ text: "", spacing: { before: 200 } }),

        new Paragraph({
          children: [new TextRun({ text: "Attendances", bold: true, size: 24, color: "000000" })],
        }),

        new Table({
          width: { size: 100, type: WidthType.PERCENTAGE },
          rows: [
            new TableRow({
              children: [
                headerCell("No.", 8),
                headerCell("Nama", 27),
                headerCell("Perusahaan", 30),
                headerCell("Jabatan/Departemen", 35),
              ],
            }),
            new TableRow({
              children: [
                bodyCell("{#attendees}{no}.", 8),
                bodyCell("{name}", 27),
                bodyCell("{company}", 30),
                bodyCell("{position}{/attendees}", 35),
              ],
            }),
          ],
        }),

        new Paragraph({ text: "", spacing: { before: 300 } }),
        new Paragraph({
          children: [new TextRun({ text: "{notes}", italics: true, size: 18 })],
        }),
      ],
    },
  ],
});

const outDir = path.resolve(__dirname, "..", "Template");
if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
const outPath = path.join(outDir, "mom_meeting_minutes_template.docx");

Packer.toBuffer(doc).then((buffer) => {
  fs.writeFileSync(outPath, buffer);
  console.log("Template Meeting Minutes dibuat:", outPath);
});
