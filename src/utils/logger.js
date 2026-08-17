const chalk = require("chalk");

function timestamp() {
  return new Date().toLocaleTimeString("id-ID");
}

module.exports = {
  info: (msg) => console.log(chalk.cyan(`[${timestamp()}] ℹ ${msg}`)),
  success: (msg) => console.log(chalk.green(`[${timestamp()}] ✔ ${msg}`)),
  warn: (msg) => console.log(chalk.yellow(`[${timestamp()}] ⚠ ${msg}`)),
  error: (msg) => console.log(chalk.red(`[${timestamp()}] ✖ ${msg}`)),
  title: (msg) => console.log(chalk.bold.magenta(`\n=== ${msg} ===\n`)),
};
