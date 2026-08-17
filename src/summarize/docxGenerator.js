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
const config = require("../config/config");

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
    children: [
      new Paragraph({
        children: [new TextRun({ text, bold: true, size: 20, color: "404041" })],
      }),
    ],
  });
}

function bodyCell(text, widthPct) {
  return new TableCell({
    width: { size: widthPct, type: WidthType.PERCENTAGE },
    borders: BORDER,
    margins: CELL_MARGINS,
    children: [
      new Paragraph({
        children: [new TextRun({ text: text || "-", size: 20 })],
      }),
    ],
  });
}

function infoRow(label, value) {
  return new TableRow({
    children: [
      new TableCell({
        width: { size: 25, type: WidthType.PERCENTAGE },
        borders: BORDER,
        margins: CELL_MARGINS,
        shading: { type: ShadingType.CLEAR, fill: "E7E6E6" },
        children: [
          new Paragraph({
            children: [new TextRun({ text: label, bold: true, size: 20 })],
          }),
        ],
      }),
      new TableCell({
        width: { size: 75, type: WidthType.PERCENTAGE },
        borders: BORDER,
        margins: CELL_MARGINS,
        children: [
          new Paragraph({
            children: [new TextRun({ text: value || "-", size: 20 })],
          }),
        ],
      }),
    ],
  });
}

/**
 * Membuat dokumen MoM (.docx) mengikuti struktur template perusahaan:
 * - Header info (Subject, Hari/Tanggal, Media, Peserta, Disusun oleh)
 * - Tabel A: Pembahasan dan Kesepakatan
 * - Tabel B: Action Items
 * - Catatan kaki
 */
function buildMomDocument(mom) {
  const discussionRows = (mom.discussion || []).map(
    (d, i) =>
      new TableRow({
        children: [
          bodyCell(String(d.no || i + 1), 6),
          bodyCell(d.topic, 20),
          bodyCell(d.status, 37),
          bodyCell(d.agreement, 37),
        ],
      })
  );

  const actionRows = (mom.actionItems || []).map(
    (a, i) =>
      new TableRow({
        children: [
          bodyCell(String(a.no || i + 1), 6),
          bodyCell(a.item, 54),
          bodyCell(a.pic, 20),
          bodyCell(a.target, 20),
        ],
      })
  );

  const children = [
    new Paragraph({
      alignment: AlignmentType.CENTER,
      children: [
        new TextRun({
          text: "MINUTES OF MEETING (MoM)",
          bold: true,
          size: 28,
        }),
      ],
    }),
  ];

  if (config.mom.orgName || mom.subject) {
    children.push(
      new Paragraph({
        alignment: AlignmentType.CENTER,
        spacing: { after: 200 },
        children: [
          new TextRun({
            text: config.mom.orgName
              ? `${config.mom.orgName} — ${mom.subject}`
              : mom.subject,
            italics: true,
            size: 22,
          }),
        ],
      })
    );
  }

  children.push(
    new Table({
      width: { size: 100, type: WidthType.PERCENTAGE },
      rows: [
        infoRow("Subject", mom.subject),
        infoRow("Hari / Tanggal", mom.dateLabel),
        infoRow("Media", mom.media),
        infoRow("Peserta", mom.participants),
        infoRow("Disusun oleh", mom.preparedBy),
      ],
    }),

    new Paragraph({ text: "", spacing: { after: 200 } }),

    new Paragraph({
      heading: HeadingLevel.HEADING_2,
      children: [
        new TextRun({ text: "A. Pembahasan dan Kesepakatan", bold: true, size: 24, color: "000000" }),
      ],
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
        ...(discussionRows.length
          ? discussionRows
          : [
              new TableRow({
                children: [
                  bodyCell("1", 6),
                  bodyCell("Tidak ada data", 20),
                  bodyCell("-", 37),
                  bodyCell("-", 37),
                ],
              }),
            ]),
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
        ...(actionRows.length
          ? actionRows
          : [
              new TableRow({
                children: [
                  bodyCell("1", 6),
                  bodyCell("Tidak ada action item", 54),
                  bodyCell("-", 20),
                  bodyCell("-", 20),
                ],
              }),
            ]),
      ],
    }),

    new Paragraph({ text: "", spacing: { before: 300 } }),

    new Paragraph({
      children: [
        new TextRun({
          text:
            mom.notes ||
            "Catatan: Notulen ini dihasilkan otomatis oleh MeetResult berdasarkan transkripsi rapat. Apabila terdapat koreksi, mohon disampaikan kepada penyusun paling lambat 2 (dua) hari kerja setelah distribusi.",
          italics: true,
          size: 18,
        }),
      ],
    })
  );

  return new Document({
    sections: [
      {
        properties: {
          page: {
            margin: { top: 720, bottom: 720, left: 720, right: 720 }, // 0.5 inch
          },
        },
        children,
      },
    ],
  });
}

async function saveMomDocx(mom, outputFilePath) {
  const doc = buildMomDocument(mom);
  const buffer = await Packer.toBuffer(doc);
  fs.writeFileSync(outputFilePath, buffer);
  return outputFilePath;
}

module.exports = { buildMomDocument, saveMomDocx };
