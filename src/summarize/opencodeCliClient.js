const { spawn } = require("child_process");
const config = require("../config/config");

// Batas wajar ukuran prompt yang dikirim lewat argumen command (mirip agyCliClient.js)
const MAX_PROMPT_LENGTH = 800000;

/**
 * Ambil semua potongan teks respons dari output `opencode run --format json` (NDJSON - satu
 * event JSON per baris). Cuma ambil event type "text" (isi balasan asisten) - event lain
 * (step_start/step_finish/tool/dll) diabaikan. Digabung berurutan untuk jaga-jaga kalau
 * responsnya terpecah jadi beberapa part teks.
 */
function extractTextFromNdjson(output) {
  const lines = output.split("\n").filter((l) => l.trim());
  let text = "";
  for (const line of lines) {
    let event;
    try {
      event = JSON.parse(line);
    } catch (e) {
      continue;
    }
    if (event.type === "text" && event.part && typeof event.part.text === "string") {
      text += event.part.text;
    }
  }
  return text;
}

/**
 * Kirim prompt teks ke OpenCode CLI (`opencode run`) dan kembalikan teks respons mentah.
 * Sama seperti agy/Claude CLI - shell-out ke binary resmi yang sudah user install & login
 * sendiri (`opencode providers login`), BUKAN reverse-engineer OAuth.
 *
 * HANYA untuk notulen (teks) - SENGAJA TIDAK dipakai untuk transkripsi audio, karena
 * attachment file audio di CLI opencode belum berfungsi (`-f <audio>` gagal dengan "Cannot
 * read binary file"), dan begitu gagal, model mencoba menjalankan perintah shell sendiri di
 * mesin ini untuk mencari cara lain (mis. `which whisper`) - perilaku agentic yang tidak
 * aman untuk pipeline otomatis. Prompt teks biasa (tanpa file attachment) tidak memicu ini.
 */
function askOpencodeCli(fullPrompt) {
  return new Promise((resolve, reject) => {
    if (fullPrompt.length > MAX_PROMPT_LENGTH) {
      return reject(
        new Error(`Prompt terlalu panjang untuk OpenCode CLI (${fullPrompt.length} > ${MAX_PROMPT_LENGTH} karakter).`)
      );
    }

    const args = ["run", fullPrompt, "--format", "json"];
    if (config.opencode.model) {
      args.push("-m", config.opencode.model);
    }

    const proc = spawn(config.opencode.cliBin, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (d) => (stdout += d.toString()));
    proc.stderr.on("data", (d) => (stderr += d.toString()));

    proc.on("error", (err) => {
      reject(
        new Error(
          `Gagal menjalankan OpenCode CLI ('${config.opencode.cliBin}'). Pastikan sudah terinstall & login ` +
            `('opencode providers login'). Detail: ${err.message}`
        )
      );
    });

    proc.on("close", (code) => {
      if (code !== 0) {
        return reject(
          new Error(`OpenCode CLI keluar dengan kode error ${code}: ${(stderr || stdout).slice(0, 500)}`)
        );
      }
      const text = extractTextFromNdjson(stdout);
      if (!text.trim()) {
        return reject(new Error("OpenCode CLI tidak mengembalikan teks respons."));
      }
      resolve(text);
    });
  });
}

module.exports = { askOpencodeCli };
