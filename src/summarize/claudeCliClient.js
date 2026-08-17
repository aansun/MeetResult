const { spawn } = require("child_process");
const config = require("../config/config");

/**
 * Panggil Claude Code CLI (`claude -p "..."`) secara non-interaktif (headless/print mode).
 * Menggunakan sesi login/subscription Claude Code yang sudah aktif di mesin ini
 * (`claude login`), TANPA butuh ANTHROPIC_API_KEY terpisah.
 *
 * Prompt (system + user) dikirim lewat stdin agar aman untuk teks panjang
 * (transkrip rapat) tanpa terbentur batas panjang argumen shell.
 */
function askClaudeCli(fullPrompt) {
  return new Promise((resolve, reject) => {
    const args = ["-p", "--output-format", "text"];
    if (config.claude.cliModel) {
      args.push("--model", config.claude.cliModel);
    }

    // Bersihkan env var Anthropic API (dipakai mode "api") agar tidak bentrok/override
    // sesi login Claude Code CLI, misalnya ANTHROPIC_MODEL yang formatnya beda dengan
    // penamaan model di Claude Code (menyebabkan error "model may not exist").
    const cleanEnv = { ...process.env };
    delete cleanEnv.ANTHROPIC_API_KEY;
    delete cleanEnv.ANTHROPIC_MODEL;
    delete cleanEnv.ANTHROPIC_BASE_URL;

    const proc = spawn(config.claude.cliBin, args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: cleanEnv,
    });

    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (d) => (stdout += d.toString()));
    proc.stderr.on("data", (d) => (stderr += d.toString()));

    proc.on("error", (err) => {
      reject(
        new Error(
          `Gagal menjalankan Claude Code CLI ('${config.claude.cliBin}'). ` +
            `Pastikan sudah terinstall & login (jalankan 'claude login' di terminal). Detail: ${err.message}`
        )
      );
    });

    proc.on("close", (code) => {
      if (code !== 0) {
        return reject(
          new Error(
            `Claude Code CLI keluar dengan kode error ${code}. ${stderr || ""}`
          )
        );
      }
      resolve(stdout.trim());
    });

    proc.stdin.write(fullPrompt);
    proc.stdin.end();
  });
}

module.exports = { askClaudeCli };
