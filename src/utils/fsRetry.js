// Error file SEMENTARA yang wajar terjadi di folder yang disinkronkan iCloud File Provider atau
// saat izin akses folder macOS sedang diperiksa (insiden nyata: EPERM pada db.json & template
// berulang selama beberapa menit lalu hilang sendiri, membuat meeting tersangkut "processing").
const TRANSIENT_FS_CODES = new Set(["EPERM", "EBUSY", "EAGAIN", "EACCES", "EMFILE"]);

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function isTransientFsError(err) {
  return !!err && TRANSIENT_FS_CODES.has(err.code);
}

/**
 * Jalankan operasi file sinkron `fn`; kalau gagal dengan error SEMENTARA, ulangi sampai `tries`
 * kali dengan jeda bertambah (delayMs, 2x, 3x...). Error lain/ENOENT langsung dilempar.
 */
function withFsRetry(fn, { tries = 5, delayMs = 400 } = {}) {
  let lastErr;
  for (let attempt = 1; attempt <= tries; attempt++) {
    try {
      return fn();
    } catch (err) {
      lastErr = err;
      if (!isTransientFsError(err) || attempt === tries) throw err;
      sleepSync(delayMs * attempt);
    }
  }
  throw lastErr;
}

module.exports = { withFsRetry, isTransientFsError, sleepSync };
