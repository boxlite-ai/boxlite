import { run } from './cli.js';

run(process.argv.slice(2), {
  cwd: process.cwd(),
  env: process.env,
  io: { stdout: process.stdout, stderr: process.stderr, stdin: process.stdin, isTTY: Boolean(process.stdout.isTTY && process.stdin.isTTY) },
}).then(
  (code) => {
    process.exitCode = code;
  },
  (e) => {
    process.stderr.write(`error: ${(e as Error).stack ?? e}\n`);
    process.exitCode = 1;
  },
);
