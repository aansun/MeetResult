const { spawn } = require("child_process");
const config = require("../config/config");

// Batas aman argumen shell (ARG_MAX macOS biasanya ~1MB, dijaga jauh di bawah itu supaya
// tidak mepet kalau ada environment variable besar lain yang ikut terhitung oleh OS).
const MAX_PROMPT_LENGTH = 800000;

/**
 * Panggil Antigravity CLI (`agy -p "..." --model ...`) secara non-interaktif (print mode),
 * memakai sesi login Antigravity yang sudah aktif di mesin ini - TANPA butuh API key terpisah.
 * Sama seperti Claude CLI: ini shell-out ke binary RESMI yang sudah user install & login
 * sendiri, BUKAN reverse-engineer OAuth/spoofing header.
 *
 * Beda penting dari Claude CLI: agy TIDAK membaca prompt dari stdin (dicoba & dikonfirmasi
 * langsung) - prompt (system+user digabung) WAJIB dikirim sebagai nilai argumen -p.
 */
function askAgyCli(fullPrompt) {
  return new Promise((resolve, reject) => {
    if (fullPrompt.length > MAX_PROMPT_LENGTH) {
      return reject(
        new Error(
          `Transkrip terlalu panjang untuk dikirim lewat argumen CLI agy (${fullPrompt.length} karakter, batas aman ${MAX_PROMPT_LENGTH}). Coba provider lain (Claude CLI pakai stdin, tidak kena batas ini).`
        )
      );
    }

    const args = ["-p", fullPrompt, "--output-format", "text"];
    if (config.agy.model) {
      args.push("--model", config.agy.model);
    }

    const proc = spawn(config.agy.cliBin, args, { stdio: ["ignore", "pipe", "pipe"] });

    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (d) => (stdout += d.toString()));
    proc.stderr.on("data", (d) => (stderr += d.toString()));

    proc.on("error", (err) => {
      reject(
        new Error(
          `Gagal menjalankan Antigravity CLI ('${config.agy.cliBin}'). Pastikan sudah terinstall & login. Detail: ${err.message}`
        )
      );
    });

    proc.on("close", (code) => {
      if (code !== 0) {
        return reject(new Error(`Antigravity CLI keluar dengan kode error ${code}. ${stderr || ""}`));
      }
      resolve(stdout.trim());
    });
  });
}

module.exports = { askAgyCli };
