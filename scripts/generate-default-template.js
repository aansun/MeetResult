/**
 * Script sekali-jalan untuk membuat file Template/mom_template.docx (template dasar
 * bertag) berdasarkan struktur MoM standar. Jalankan ulang jika ingin reset ke default:
 *
 *   node scripts/generate-default-template.js
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
  HeadingLevel,
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
          children: [new TextRun({ text: "MINUTES OF MEETING (MoM)", bold: true, size: 28 })],
        }),
        new Paragraph({
          alignment: AlignmentType.CENTER,
          spacing: { after: 200 },
          children: [new TextRun({ text: "{subject}", italics: true, size: 22 })],
        }),

        new Table({
          width: { size: 100, type: WidthType.PERCENTAGE },
          rows: [
            infoRow("Subject", "{subject}"),
            infoRow("Hari / Tanggal", "{dateLabel}"),
            infoRow("Media", "{media}"),
            infoRow("Peserta", "{participants}"),
            infoRow("Disusun oleh", "{preparedBy}"),
          ],
        }),

        new Paragraph({ text: "", spacing: { after: 200 } }),

        new Paragraph({
          heading: HeadingLevel.HEADING_2,
          children: [new TextRun({ text: "A. Pembahasan dan Kesepakatan", bold: true, size: 24, color: "000000" })],
        }),

        new Table({
          width: { size: 100, type: WidthType.PERCENTAGE },
          rows: [
            new TableRow({
              children: [
                headerCell("No", 6),
                headerCell("Topik", 20),
                headerCell("Status / Pembahasan", 37),
                headerCell("Kesepakatan", 37),
              ],
            }),
            // Baris ini akan otomatis diulang oleh docxtemplater untuk setiap
            // item di array "discussion". Tag pembuka {#discussion} HARUS ada
            // di sel pertama, tag penutup {/discussion} di sel terakhir baris ini.
            new TableRow({
              children: [
                bodyCell("{#discussion}{no}", 6),
                bodyCell("{topic}", 20),
                bodyCell("{status}", 37),
                bodyCell("{agreement}{/discussion}", 37),
              ],
            }),
          ],
        }),

        new Paragraph({ text: "", spacing: { after: 200 } }),

        new Paragraph({
          heading: HeadingLevel.HEADING_2,
          children: [new TextRun({ text: "B. Action Items", bold: true, size: 24, color: "000000" })],
        }),

        new Table({
          width: { size: 100, type: WidthType.PERCENTAGE },
          rows: [
            new TableRow({
              children: [
                headerCell("No", 6),
                headerCell("Action Item", 54),
                headerCell("PIC", 20),
                headerCell("Target", 20),
              ],
            }),
            new TableRow({
              children: [
                bodyCell("{#actionItems}{no}", 6),
                bodyCell("{item}", 54),
                bodyCell("{pic}", 20),
                bodyCell("{target}{/actionItems}", 20),
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
const outPath = path.join(outDir, "mom_template.docx");

Packer.toBuffer(doc).then((buffer) => {
  fs.writeFileSync(outPath, buffer);
  console.log("Template default dibuat:", outPath);
});
