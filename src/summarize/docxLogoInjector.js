const fs = require("fs");
const path = require("path");

/**
 * Menyisipkan logo (gambar) ke dalam dokumen .docx secara MANUAL (manipulasi OOXML
 * langsung lewat PizZip), tanpa dependency npm tambahan yang rawan keamanan
 * (docxtemplater-image-module-free punya vulnerability critical di xmldom).
 *
 * Logo dibaca dari file LOKAL (Template/logo.*) saat generate dokumen, TIDAK pernah
 * di-bake ke dalam file template yang di-commit/publish. Kalau file logo tidak ada
 * (mis. di komputer orang lain yang clone project ini), placeholder {%logo} akan
 * dihapus begitu saja tanpa error - dokumen tetap dihasilkan normal tanpa logo.
 *
 * Cara pakai di template .docx: taruh teks placeholder "{%logo}" (persis, termasuk
 * kurung kurawal) di paragraf tempat logo ingin muncul.
 */

const LOGO_TAG = "{%logo}";
const MAX_WIDTH_EMU = 1800000; // ~1.97 inch, EMU = 914400 per inch

function emuFromPixels(px, dpi = 96) {
  return Math.round((px / dpi) * 914400);
}

function getImageMimeAndExt(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const map = {
    ".jpg": { mime: "image/jpeg", ext: "jpeg" },
    ".jpeg": { mime: "image/jpeg", ext: "jpeg" },
    ".png": { mime: "image/png", ext: "png" },
  };
  return map[ext] || null;
}

/**
 * Baca dimensi asli gambar JPEG/PNG (lebar x tinggi piksel) tanpa dependency
 * eksternal, cukup parsing header file secara manual.
 */
function getImageDimensions(buffer, ext) {
  if (ext === "png") {
    // PNG: lebar/tinggi ada di byte 16-23 (big-endian, setelah signature+IHDR chunk header)
    const width = buffer.readUInt32BE(16);
    const height = buffer.readUInt32BE(20);
    return { width, height };
  }

  // JPEG: cari marker SOF0/SOF2 (0xFFC0 / 0xFFC2) untuk ambil dimensi
  let offset = 2; // skip SOI marker (0xFFD8)
  while (offset < buffer.length) {
    if (buffer[offset] !== 0xff) {
      offset++;
      continue;
    }
    const marker = buffer[offset + 1];
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      const height = buffer.readUInt16BE(offset + 5);
      const width = buffer.readUInt16BE(offset + 7);
      return { width, height };
    }
    const segmentLength = buffer.readUInt16BE(offset + 2);
    offset += 2 + segmentLength;
  }
  // Fallback kalau parsing gagal
  return { width: 800, height: 200 };
}

/**
 * Sisipkan logo ke PizZip instance (docx yang sudah dimuat) di posisi placeholder
 * "{%logo}". Jika logoPath tidak ada, placeholder cukup dihapus (tanpa gambar).
 */
function injectLogo(zip, logoPath) {
  const documentXmlPath = "word/document.xml";
  let documentXml = zip.file(documentXmlPath).asText();

  if (!documentXml.includes(LOGO_TAG)) {
    return; // Template ini tidak punya placeholder logo, tidak ada yang perlu dilakukan
  }

  if (!logoPath || !fs.existsSync(logoPath)) {
    // Tidak ada file logo di komputer ini -> hapus placeholder saja, dokumen tetap valid
    documentXml = documentXml.split(LOGO_TAG).join("");
    zip.file(documentXmlPath, documentXml);
    return;
  }

  const info = getImageMimeAndExt(logoPath);
  if (!info) {
    documentXml = documentXml.split(LOGO_TAG).join("");
    zip.file(documentXmlPath, documentXml);
    return;
  }

  const imageBuffer = fs.readFileSync(logoPath);
  const { width, height } = getImageDimensions(imageBuffer, info.ext);
  const aspectRatio = height / width;

  const widthEmu = Math.min(MAX_WIDTH_EMU, emuFromPixels(width));
  const heightEmu = Math.round(widthEmu * aspectRatio);

  // 1. Tambahkan file gambar ke dalam paket docx (word/media/)
  const mediaFileName = `meetresult-logo.${info.ext}`;
  zip.file(`word/media/${mediaFileName}`, imageBuffer);

  // 2. Daftarkan relationship (rId) yang menunjuk ke file gambar tsb
  const relsPath = "word/_rels/document.xml.rels";
  let relsXml = zip.file(relsPath).asText();
  const relId = `rIdMeetResultLogo`;
  const relEntry = `<Relationship Id="${relId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/${mediaFileName}"/>`;
  if (!relsXml.includes(relId)) {
    relsXml = relsXml.replace("</Relationships>", `${relEntry}</Relationships>`);
    zip.file(relsPath, relsXml);
  }

  // 3. Pastikan [Content_Types].xml mengenali ekstensi gambar ini
  const contentTypesPath = "[Content_Types].xml";
  let contentTypesXml = zip.file(contentTypesPath).asText();
  const defaultEntry = `<Default Extension="${info.ext}" ContentType="${info.mime}"/>`;
  if (!contentTypesXml.includes(`Extension="${info.ext}"`)) {
    contentTypesXml = contentTypesXml.replace("</Types>", `${defaultEntry}</Types>`);
    zip.file(contentTypesPath, contentTypesXml);
  }

  // 4. Ganti placeholder teks "{%logo}" dengan elemen <w:drawing> yang merujuk ke rId di atas
  const drawingXml =
    `<w:r><w:drawing>` +
    `<wp:inline distT="0" distB="0" distL="0" distR="0">` +
    `<wp:extent cx="${widthEmu}" cy="${heightEmu}"/>` +
    `<wp:docPr id="1" name="MeetResultLogo"/>` +
    `<a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">` +
    `<a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">` +
    `<pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">` +
    `<pic:nvPicPr><pic:cNvPr id="1" name="MeetResultLogo"/><pic:cNvPicPr/></pic:nvPicPr>` +
    `<pic:blipFill><a:blip r:embed="${relId}" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"/>` +
    `<a:stretch><a:fillRect/></a:stretch></pic:blipFill>` +
    `<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${widthEmu}" cy="${heightEmu}"/></a:xfrm>` +
    `<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr>` +
    `</pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>`;

  // Ganti seluruh elemen <w:r>...{%logo}...</w:r> (termasuk <w:rPr> jika ada) dengan
  // elemen <w:drawing> gambar logo. Placeholder "{%logo}" diasumsikan utuh dalam satu
  // <w:t> (aman karena template dibuat terprogram lewat scripts/generate-*.js, bukan
  // hasil ketikan manual di Word yang kadang memecah teks jadi beberapa run).
  const runWithLogoRegex = /<w:r>(?:(?!<\/w:r>)[\s\S])*\{%logo\}(?:(?!<\/w:r>)[\s\S])*<\/w:r>/;
  if (runWithLogoRegex.test(documentXml)) {
    documentXml = documentXml.replace(runWithLogoRegex, drawingXml);
  } else {
    // Fallback: kalau pola run tidak ketemu persis, minimal hapus teks placeholder-nya
    documentXml = documentXml.split(LOGO_TAG).join("");
  }

  zip.file(documentXmlPath, documentXml);
}

module.exports = { injectLogo, LOGO_TAG };
