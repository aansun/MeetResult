const fs = require("fs");

const WAV_HEADER_BYTES = 44; // header PCM WAV standar (cukup untuk file hasil ffmpeg -f wav)

/**
 * Cek apakah ada aktivitas suara (bukan diam total) di beberapa detik TERAKHIR sebuah file
 * .wav PCM 16-bit mono - termasuk file yang SEDANG ditulis ffmpeg (aman dibaca paralel,
 * hanya baca, tidak tulis). Dipakai untuk mendeteksi apakah channel audio system (BlackHole,
 * suara lawan bicara di Teams) benar-benar mengalirkan suara meeting - kalau diam total
 * dalam waktu lama, kemungkinan besar TIDAK ada call aktif meski jadwalnya ada di kalender.
 *
 * Return null kalau belum bisa dicek (file belum ada / belum cukup data ditulis).
 */
function hasRecentAudioActivity(
  wavFilePath,
  { lookbackSeconds = 60, sampleRate = 16000, thresholdDb = -50 } = {}
) {
  if (!fs.existsSync(wavFilePath)) return null;

  const stat = fs.statSync(wavFilePath);
  const bytesPerSecond = sampleRate * 2; // PCM 16-bit mono
  const lookbackBytes = lookbackSeconds * bytesPerSecond;

  const dataStart = Math.max(WAV_HEADER_BYTES, stat.size - lookbackBytes);
  const readLength = stat.size - dataStart;
  if (readLength <= 0) return null;

  const fd = fs.openSync(wavFilePath, "r");
  const buffer = Buffer.alloc(readLength);
  fs.readSync(fd, buffer, 0, readLength, dataStart);
  fs.closeSync(fd);

  const sampleCount = Math.floor(buffer.length / 2);
  if (sampleCount === 0) return null;

  let sumSquares = 0;
  for (let i = 0; i < sampleCount; i++) {
    const sample = buffer.readInt16LE(i * 2);
    sumSquares += sample * sample;
  }
  const rms = Math.sqrt(sumSquares / sampleCount);
  const dbfs = rms > 0 ? 20 * Math.log10(rms / 32768) : -Infinity;

  return { dbfs, isSilent: dbfs < thresholdDb };
}

module.exports = { hasRecentAudioActivity };
